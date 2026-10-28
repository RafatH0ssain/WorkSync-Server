require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express();
app.disable('x-powered-by');
const port = process.env.PORT || 5000;

// ---------------------------------------------------------------------------
// Tunables. Limits are deliberately small: this API serves a company roster,
// not an analytics warehouse.
// ---------------------------------------------------------------------------
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;
// Ceiling for reads that feed an in-process total (per employee only).
const INTERNAL_FETCH_CAP = 5000;
const MAX_BODY = '100kb';
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = (() => {
    const n = Number(process.env.RATE_LIMIT_MAX);
    return Number.isInteger(n) && n >= 1 && n <= 100000 ? n : 120;
})();
const MAXLEN = {
    name: 200,
    email: 254,
    uid: 128,
    url: 2048,
    text: 5000,
    task: 500,
    date: 40,
    status: 32,
    heading: 200,
    designation: 100,
    paidBy: 200,
    entries: 500,
};

// ---------------------------------------------------------------------------
// Small pure helpers (exported at the bottom so the verify script can unit
// test them without a database).
// ---------------------------------------------------------------------------

// Express 4 does not catch rejected promises from handlers. Wrapping keeps a
// stray rejection from becoming an unhandledRejection and killing the process.
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

// new ObjectId(undefined) silently mints a fresh id in mongodb 5.x, and
// new ObjectId({}) can cast operator objects. Only accept 24 hex characters.
function isValidObjectId(value) {
    return typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);
}

// ?limit= for list endpoints: default DEFAULT_LIMIT, capped at MAX_LIMIT,
// null when the caller sent something that is not a positive integer.
function parseLimit(raw) {
    if (raw === undefined || raw === '') return DEFAULT_LIMIT;
    if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw)) return null;
    const n = Number(raw);
    if (n < 1) return null;
    return Math.min(n, MAX_LIMIT);
}

function isStr(value, max) {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isOptStr(value, max) {
    return value === undefined || (typeof value === 'string' && value.length <= max);
}

// Own-record check for the single-record reads. uid compares exactly, email
// compares case-insensitively.
function isSelfMatch(requested, claim, field) {
    if (typeof requested !== 'string' || typeof claim !== 'string') return false;
    if (field === 'email') return requested.toLowerCase() === claim.toLowerCase();
    return requested === claim;
}

// In-memory fixed-window rate limiter keyed by client address. One bucket per
// address per minute; enough for a single-process portfolio API. Multi-instance
// deployments need a shared store (see README).
function makeRateLimiter(windowMs, max) {
    const buckets = new Map();
    return function rateLimit(req, res, next) {
        const now = Date.now();
        const key = req.ip || req.socket.remoteAddress || 'unknown';
        let bucket = buckets.get(key);
        if (!bucket || now - bucket.start >= windowMs) {
            bucket = { start: now, count: 0 };
            buckets.set(key, bucket);
        }
        bucket.count += 1;
        if (buckets.size > 10000) {
            for (const [k, b] of buckets) {
                if (now - b.start >= windowMs) buckets.delete(k);
            }
        }
        if (bucket.count > max) {
            res.setHeader('Retry-After', String(Math.ceil((bucket.start + windowMs - now) / 1000)));
            return res.status(429).json({ error: 'Too many requests' });
        }
        next();
    };
}

// ---------------------------------------------------------------------------
// MongoDB connection string. MONGO_URI wins; otherwise the credentials are
// stitched together. MONGO_CLUSTER overrides the default Atlas host below.
// ---------------------------------------------------------------------------
const uri = process.env.MONGO_URI
    || `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PW}@${process.env.MONGO_CLUSTER || 'cluster0.oyqb2.mongodb.net'}/?retryWrites=true&w=majority&appName=Cluster0`;

// ---------------------------------------------------------------------------
// CORS. Browser hygiene only, never an authorization boundary. x-admin-token
// must be listed or preflight strips it from real browser calls.
// ---------------------------------------------------------------------------
const allowedOrigins = [
    'https://worksync-2ca3b.web.app',
    'https://worksync-2ca3b.firebaseapp.com',
    'http://localhost:5173'
];

const corsOptions = {
    origin: (origin, callback) => {
        if (allowedOrigins.includes(origin) || !origin) {
            callback(null, true);
        } else {
            // Not an error path: refuse the origin without a 500.
            callback(null, false);
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token']
};

// ---------------------------------------------------------------------------
// Cross-cutting middleware. Order matters: ids and headers first, then body
// parsing and rate limiting, then routes. The error handler sits after the
// routes so it can actually see their failures.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    const start = Date.now();
    res.setHeader('X-Request-Id', req.id);
    res.on('finish', () => {
        console.log(`[${req.id}] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
});

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    next();
});

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: MAX_BODY }));

const rateLimit = makeRateLimiter(RATE_WINDOW_MS, RATE_MAX);
app.use((req, res, next) => {
    // Health probes must stay answerable under load or after a scrape burst.
    if (req.method === 'GET' && req.path === '/') return next();
    return rateLimit(req, res, next);
});

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

const db = client.db("WorkSync");
const allUsersCollection = db.collection("Users");
const adminCollection = db.collection("AdminUsers");
const hrCollection = db.collection("HRUsers");
const employeeCollection = db.collection("EmployeeUsers");
const paymentRequestsCollection = db.collection("PaymentRequests");
const worksheetCollection = db.collection("EmployeeWorksheets");
const queriesCollection = db.collection("Queries");
const salaryHistoryCollection = db.collection("SalaryHistory");

// Whether the MongoDB connection is up. Routes that touch the database check
// this first and answer 503 instead of hanging on a dead connection.
const dbState = { connected: false };

function requireDb(req, res, next) {
    if (!dbState.connected) {
        return res.status(503).json({ error: 'Database unavailable. Try again shortly.' });
    }
    next();
}

function safeEqual(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Shared-secret gate for privileged operations. Callers must send the
// x-admin-token header matching the ADMIN_TOKEN env var. When ADMIN_TOKEN is
// empty or absent every route behind this middleware is disabled with 503.
// The server never reads a role out of the request: privileged actions are
// gated by this secret, and roles written to the database are decided here.
function requireAdmin(req, res, next) {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected) {
        return res.status(503).json({ error: 'Admin API disabled: ADMIN_TOKEN is not set' });
    }
    const provided = req.get('x-admin-token');
    if (!provided || !safeEqual(provided, expected)) {
        return res.status(401).json({ error: 'Missing or invalid x-admin-token header' });
    }
    next();
}

// ---------------------------------------------------------------------------
// Firebase ID-token auth. Credentials resolve in this order:
//   1. GOOGLE_APPLICATION_CREDENTIALS, a key file outside the repo (local dev)
//   2. Application Default Credentials (Google Cloud)
//   3. FIREBASE_SERVICE_ACCOUNT, the key JSON as a string (Vercel and similar)
// When none of them is usable the app still boots: a log line marks ID-token
// auth as disabled and every ID-token route answers 401. The x-admin-token
// path is unaffected either way.
// ---------------------------------------------------------------------------
let firebaseAuth = null;

// ADC is lazy: it constructs without any platform credential and only fails
// when used. This host check keeps the Google Cloud path from swallowing the
// FIREBASE_SERVICE_ACCOUNT fallback on hosts with no ADC at all.
function isGoogleCloudHost() {
    return Boolean(process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
        || process.env.K_SERVICE || process.env.GAE_SERVICE
        || process.env.FUNCTION_NAME || process.env.FUNCTION_TARGET);
}

(function initFirebaseAuth() {
    let sdk;
    try {
        sdk = {
            ...require('firebase-admin/app'),
            getAuth: require('firebase-admin/auth').getAuth
        };
    } catch (err) {
        console.error('Firebase ID-token auth disabled: firebase-admin failed to load:', err.message);
        return;
    }

    let credential = null;
    let source = '';
    const attempts = [];

    // 1. GOOGLE_APPLICATION_CREDENTIALS: key file outside the repo.
    const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (keyPath) {
        try {
            credential = sdk.cert(keyPath);
            source = 'GOOGLE_APPLICATION_CREDENTIALS';
        } catch (err) {
            attempts.push(`GOOGLE_APPLICATION_CREDENTIALS: ${err.message}`);
        }
    }
    // 2. Application Default Credentials.
    if (!credential && isGoogleCloudHost()) {
        try {
            credential = sdk.applicationDefault();
            source = 'application default credentials';
        } catch (err) {
            attempts.push(`application default credentials: ${err.message}`);
        }
    }
    // 3. FIREBASE_SERVICE_ACCOUNT: the key JSON as a string.
    if (!credential && process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            credential = sdk.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
            source = 'FIREBASE_SERVICE_ACCOUNT';
        } catch (err) {
            attempts.push(`FIREBASE_SERVICE_ACCOUNT: ${err.message}`);
        }
    }

    if (!credential) {
        console.error('Firebase ID-token auth disabled: no usable credentials'
            + (attempts.length ? ` (${attempts.join('; ')})` : '')
            + '. ID-token routes answer 401; x-admin-token still works.');
        return;
    }
    try {
        if (sdk.getApps().length === 0) {
            sdk.initializeApp({ credential });
        }
        firebaseAuth = sdk.getAuth();
        console.log(`Firebase ID-token auth enabled via ${source}`);
    } catch (err) {
        firebaseAuth = null;
        console.error('Firebase ID-token auth disabled: initialization failed:', err.message);
    }
})();

// Per-user gate: Authorization: Bearer <firebase-id-token>. Every failure
// answers 401 with the same body; the SDK error stays in the server log.
const requireUser = asyncHandler(async (req, res, next) => {
    if (!firebaseAuth) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const match = /^Bearer\s+(\S+)$/.exec(req.get('authorization') || '');
    if (!match) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    try {
        const decoded = await firebaseAuth.verifyIdToken(match[1]);
        req.user = { uid: decoded.uid, email: decoded.email };
        next();
    } catch (err) {
        console.error(`[${req.id}] ID token rejected:`, err.message);
        return res.status(401).json({ error: 'Authentication required' });
    }
});

// Either credential opens these routes: a verified ID token or x-admin-token.
// The admin path is tried first so a request carrying both keeps the admin
// rights the shared secret grants.
function requireUserOrAdmin(req, res, next) {
    const expected = process.env.ADMIN_TOKEN;
    const provided = req.get('x-admin-token');
    if (expected && provided && safeEqual(provided, expected)) {
        req.adminCall = true;
        return next();
    }
    return requireUser(req, res, next);
}

// Own-record gate for the single-record reads. A caller who got in with an ID
// token reads only their own record; admin-token callers read any record.
function requireSelf(field) {
    return (req, res, next) => {
        if (req.adminCall) return next();
        if (!isSelfMatch(req.params[field], req.user && req.user[field], field)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        next();
    };
}

// ---------------------------------------------------------------------------
// Trust-boundary validators. These run before requireDb so bad input answers
// 400 even when the database is down, and so no operator object or oversized
// string ever reaches a query.
// ---------------------------------------------------------------------------

function requireObjectIdParam(name) {
    return (req, res, next) => {
        if (!isValidObjectId(req.params[name])) {
            return res.status(400).json({ error: `${name} must be a 24 character hex id` });
        }
        next();
    };
}

function requireStringParam(name, max) {
    return (req, res, next) => {
        if (!isStr(req.params[name], max)) {
            return res.status(400).json({ error: `${name} must be a non-empty string of at most ${max} characters` });
        }
        next();
    };
}

function validateListQuery(req, res, next) {
    if (parseLimit(req.query.limit) === null) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
    }
    next();
}

// Boundary check for user creation. Self-registration only ever creates
// employees: promotion to hr happens via /make-hr, and nothing here can create
// an admin record. Extra fields are ignored, never spread into the document.
function validateUserRegistration(req, res, next) {
    const { name, email, photoURL, uid, userType } = req.body || {};
    if (!isStr(name, MAXLEN.name) || !isStr(email, MAXLEN.email) || !isStr(uid, MAXLEN.uid)) {
        return res.status(400).json({ message: 'name, email and uid must be strings within length limits' });
    }
    if (!isOptStr(photoURL, MAXLEN.url)) {
        return res.status(400).json({ message: 'photoURL must be a string within length limits' });
    }
    const requestedType = userType === undefined ? 'employee' : userType;
    if (requestedType !== 'employee') {
        return res.status(400).json({ message: "userType must be 'employee'" });
    }
    next();
}

function validateQuerySubmission(req, res, next) {
    const { heading, designation, details, email, submittedAt } = req.body || {};
    if (!isStr(heading, MAXLEN.heading) || !isStr(designation, MAXLEN.designation)
        || !isStr(details, MAXLEN.text) || !isStr(email, MAXLEN.email)) {
        return res.status(400).json({ error: 'heading, designation, details and email must be strings within length limits' });
    }
    if (submittedAt !== undefined
        && !(typeof submittedAt === 'string' && isStr(submittedAt, MAXLEN.date) && !Number.isNaN(Date.parse(submittedAt)))) {
        return res.status(400).json({ error: 'submittedAt must be a parseable date string' });
    }
    next();
}

function validateWorksheetBody(req, res, next) {
    const { task, hoursWorked, date, userId, email } = req.body || {};
    if (!isStr(task, MAXLEN.task) || !isStr(userId, MAXLEN.uid) || !isStr(email, MAXLEN.email)) {
        return res.status(400).json({ error: 'task, userId and email must be strings within length limits' });
    }
    const hours = typeof hoursWorked === 'string' && hoursWorked.trim() !== ''
        ? Number(hoursWorked)
        : hoursWorked;
    if (typeof hours !== 'number' || !Number.isFinite(hours)) {
        return res.status(400).json({ error: 'hoursWorked must be a number' });
    }
    if (!isStr(date, MAXLEN.date)) {
        return res.status(400).json({ error: 'date must be a string' });
    }
    next();
}

function validateWorksheetUpdate(req, res, next) {
    const body = req.body || {};
    const { task, hoursWorked, date, userId, email } = body;
    if (task !== undefined && !isStr(task, MAXLEN.task)) {
        return res.status(400).json({ error: 'task must be a string within length limits' });
    }
    if (hoursWorked !== undefined) {
        const hours = typeof hoursWorked === 'string' && hoursWorked.trim() !== ''
            ? Number(hoursWorked)
            : hoursWorked;
        if (typeof hours !== 'number' || !Number.isFinite(hours)) {
            return res.status(400).json({ error: 'hoursWorked must be a number' });
        }
    }
    if (date !== undefined && !isStr(date, MAXLEN.date)) {
        return res.status(400).json({ error: 'date must be a string' });
    }
    if (userId !== undefined && !isStr(userId, MAXLEN.uid)) {
        return res.status(400).json({ error: 'userId must be a string within length limits' });
    }
    if (email !== undefined && !isStr(email, MAXLEN.email)) {
        return res.status(400).json({ error: 'email must be a string within length limits' });
    }
    next();
}

function validatePaymentBody(req, res, next) {
    const { email, amount, paidBy, entries } = req.body || {};
    if (!isStr(email, MAXLEN.email) || !isStr(paidBy, MAXLEN.paidBy)) {
        return res.status(400).json({ error: 'email and paidBy must be strings within length limits' });
    }
    const amountValue = typeof amount === 'string' && amount.trim() !== '' ? Number(amount) : amount;
    if (typeof amountValue !== 'number' || !Number.isFinite(amountValue) || amountValue <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number' });
    }
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAXLEN.entries) {
        return res.status(400).json({ error: `entries must be a non-empty array of at most ${MAXLEN.entries} items` });
    }
    if (entries.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) || !isValidObjectId(entry._id))) {
        return res.status(400).json({ error: 'each entry must carry a 24 character hex _id' });
    }
    next();
}

function validateVerificationBody(req, res, next) {
    const { isVerified } = req.body || {};
    if (typeof isVerified !== 'boolean') {
        return res.status(400).json({ error: 'isVerified must be a boolean' });
    }
    next();
}

function validateApprovePaymentBody(req, res, next) {
    const { status } = req.body || {};
    if (!['paid', 'pending'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status value. Must be "paid" or "pending".' });
    }
    next();
}

// Salary writes carry an absolute value, so the record ends up with exactly
// the number the admin sends. Bounded to 0..99999; a JSON number that arrives
// as Infinity or NaN fails Number.isFinite and is rejected here.
function validateSalaryBody(req, res, next) {
    const { newSalary } = req.body || {};
    if (typeof newSalary !== 'number' || !Number.isFinite(newSalary) || newSalary < 0 || newSalary >= 100000) {
        return res.status(400).json({ error: 'newSalary must be a finite number from 0 up to 100000' });
    }
    next();
}

function validateQueriesQuery(req, res, next) {
    const { email } = req.query;
    if (email !== undefined && !isStr(email, MAXLEN.email)) {
        return res.status(400).json({ error: 'email must be a string within length limits' });
    }
    if (parseLimit(req.query.limit) === null) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
    }
    next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check. Reads a cached flag only, never touches the database, so it
// stays cheap and keeps answering while MongoDB is unreachable.
app.get('/', (req, res) => {
    if (dbState.connected) {
        return res.status(200).json({ status: 'ok', database: 'connected' });
    }
    res.status(503).json({ status: 'degraded', database: 'disconnected' });
});

// Probe used by verify-security.sh to prove an async handler rejection cannot
// kill the process. Not registered outside verification runs.
if (process.env.VERIFY_ASYNC_ROUTE === '1') {
    app.get('/__verify/async-reject', asyncHandler(async () => {
        throw new Error('verify: intentional async rejection');
    }));
}

app.post('/submit-query', validateQuerySubmission, requireDb, asyncHandler(async (req, res) => {
    const { heading, designation, details, submittedAt, email } = req.body;

    const queryDocument = {
        heading,
        designation,
        details,
        email,
        status: 'pending',
        submittedAt: submittedAt === undefined ? new Date() : new Date(submittedAt),
        updatedAt: new Date()
    };

    const result = await queriesCollection.insertOne(queryDocument);
    if (!result.insertedId) {
        throw new Error('Failed to insert query');
    }

    res.status(201).json({
        message: 'Query submitted successfully',
        queryId: result.insertedId
    });
}));

app.get('/queries', requireAdmin, validateQueriesQuery, requireDb, asyncHandler(async (req, res) => {
    const { email } = req.query;

    const filter = {};
    if (email) {
        filter.email = email;
    }

    const queries = await queriesCollection
        .find(filter)
        .sort({ submittedAt: -1 })
        .limit(parseLimit(req.query.limit))
        .toArray();

    res.status(200).json(queries);
}));

// Connect to MongoDB with retry and backoff. A failed connect must never kill
// the process: routes gated on requireDb answer 503 until the connection is up.
async function connectWithRetry() {
    try {
        await client.connect();

        // Test the connection
        const pingResult = await client.db("admin").command({ ping: 1 });
        dbState.connected = true;
        console.log("MongoDB connection successful!", pingResult);
    } catch (error) {
        dbState.connected = false;
        console.error("MongoDB connection failed, retrying in 5s:", error.message);
        setTimeout(connectWithRetry, 5000);
    }
}

// GET method for getting the current logged in user
app.get('/users/:uid', requireUserOrAdmin, requireStringParam('uid', MAXLEN.uid), requireSelf('uid'), requireDb, asyncHandler(async (req, res) => {
    const user = await allUsersCollection.findOne({ uid: req.params.uid });

    if (user) {
        res.status(200).json(user);
    } else {
        res.status(404).json({ error: 'No record found' });
    }
}));

// GET method for getting all users excluding admin
app.get('/users', requireAdmin, validateListQuery, requireDb, asyncHandler(async (req, res) => {
    const users = await allUsersCollection.find({
        userType: { $ne: "admin" }
    })
        .limit(parseLimit(req.query.limit))
        .toArray();

    // Always return 200 with array
    res.status(200).json(users || []);
}));

app.post('/users', validateUserRegistration, requireDb, asyncHandler(async (req, res) => {
    // Only these fields are stored. Any role-ish field in the body is dropped;
    // userType is decided here, never taken from the caller.
    const { name, email, photoURL, uid } = req.body;

    // Check if the user already exists
    const existingUser = await allUsersCollection.findOne({ email });
    if (existingUser) {
        return res.status(400).json({ message: "User already exists!" });
    }

    const newUser = {
        name,
        email,
        photoURL,
        uid,
        userType: 'employee',
        createdAt: new Date(),
    };

    await employeeCollection.insertOne(newUser);
    await allUsersCollection.insertOne(newUser);

    res.status(201).json({ message: "User registered successfully!" });
}));

app.post('/fire/:uid', requireAdmin, requireStringParam('uid', MAXLEN.uid), requireDb, asyncHandler(async (req, res) => {
    const userId = req.params.uid;

    // First find the user to determine their type. The role comes from the
    // stored record, never from the request.
    const user = await allUsersCollection.findOne({ uid: userId });

    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    let specificCollection;
    switch (user.userType?.toLowerCase()) {
        case 'hr':
            specificCollection = hrCollection;
            break;
        case 'admin':
            specificCollection = adminCollection;
            break;
        case 'employee':
        default:
            specificCollection = employeeCollection;
            break;
    }

    await Promise.all([
        specificCollection.updateOne(
            { uid: userId },
            { $set: { status: 'fired' } }
        ),
        allUsersCollection.updateOne(
            { uid: userId },
            { $set: { status: 'fired' } }
        )
    ]);

    const updatedUser = await allUsersCollection.findOne({ uid: userId });
    const updatedUsers = await allUsersCollection
        .find({})
        .limit(DEFAULT_LIMIT)
        .toArray();

    res.status(200).json({
        message: 'User fired successfully',
        user: updatedUser,
        updatedUsers: updatedUsers
    });
}));

// Add a new endpoint to check user status during login
app.get('/check-user-status/:uid', requireUserOrAdmin, requireStringParam('uid', MAXLEN.uid), requireSelf('uid'), requireDb, asyncHandler(async (req, res) => {
    const user = await allUsersCollection.findOne({ uid: req.params.uid });

    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    res.status(200).json({
        status: user.status || 'active',
        userType: user.userType
    });
}));

// Enhanced make-hr endpoint
app.post('/make-hr/:id', requireAdmin, requireObjectIdParam('id'), requireDb, asyncHandler(async (req, res) => {
    const userId = req.params.id;

    // First, find the user in the main Users collection
    const user = await allUsersCollection.findOne({ _id: new ObjectId(userId) });

    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    const hrUser = {
        ...user,
        userType: 'hr',
        promotedAt: new Date()
    };

    const session = client.startSession();

    try {
        await session.withTransaction(async () => {
            // Remove from employee collection if they were an employee
            if (user.userType === 'employee') {
                await employeeCollection.deleteOne({ _id: new ObjectId(userId) }, { session });
            }

            await hrCollection.insertOne(hrUser, { session });

            await allUsersCollection.updateOne(
                { _id: new ObjectId(userId) },
                {
                    $set: {
                        userType: 'hr',
                        promotedAt: new Date()
                    }
                },
                { session }
            );
        });
    } finally {
        await session.endSession();
    }

    const updatedUsers = await allUsersCollection
        .find({ userType: { $ne: "admin" } })
        .limit(DEFAULT_LIMIT)
        .toArray();

    res.status(200).json({
        message: 'User successfully promoted to HR',
        updatedUsers: updatedUsers
    });
}));

// Set an employee's salary and record the change. The history row keeps the
// previous value, the new value, the time, and the credential that made the
// change. The shared secret is never echoed back.
app.post('/adjust-salary/:id', requireAdmin, requireObjectIdParam('id'), validateSalaryBody, requireDb, asyncHandler(async (req, res) => {
    const userId = new ObjectId(req.params.id);
    const { newSalary } = req.body;

    const user = await allUsersCollection.findOne({ _id: userId });
    if (!user) {
        return res.status(404).json({ error: 'Employee not found' });
    }
    const previousSalary = typeof user.salary === 'number' ? user.salary : null;

    const session = client.startSession();
    try {
        await session.withTransaction(async () => {
            await allUsersCollection.updateOne(
                { _id: userId },
                { $set: { salary: newSalary } },
                { session }
            );
            await salaryHistoryCollection.insertOne({
                userId,
                previousSalary,
                newSalary,
                changedBy: 'x-admin-token',
                changedAt: new Date()
            }, { session });
        });
    } finally {
        await session.endSession();
    }

    res.status(200).json({ message: 'Salary updated successfully', previousSalary, newSalary });
}));

// Toggle employee verification status
app.post('/toggle-verification/:id', requireAdmin, requireObjectIdParam('id'), validateVerificationBody, requireDb, asyncHandler(async (req, res) => {
    const result = await allUsersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { isVerified: req.body.isVerified } }
    );

    if (result.modifiedCount === 0) {
        return res.status(404).json({ error: 'Employee not found' });
    }

    res.status(200).json({ message: 'Verification status updated successfully' });
}));

// Get salary history for an employee
app.get('/salary-history/:id', requireAdmin, requireStringParam('id', MAXLEN.uid), requireDb, asyncHandler(async (req, res) => {
    // Get approved payments for the employee
    const salaryHistory = await paymentRequestsCollection
        .find({
            employeeId: req.params.id,
            status: 'approved'
        })
        .sort({ year: 1, month: 1 })
        .limit(INTERNAL_FETCH_CAP)
        .toArray();

    // Transform data for the chart
    const formattedHistory = salaryHistory.map(payment => ({
        month: `${payment.month} ${payment.year}`,
        salary: payment.salary
    }));

    res.status(200).json(formattedHistory);
}));

// Endpoint to add a new worksheet entry
app.post('/worksheet', requireAdmin, validateWorksheetBody, requireDb, asyncHandler(async (req, res) => {
    const { task, hoursWorked, date, userId, email } = req.body;

    const hours = typeof hoursWorked === 'string' && hoursWorked.trim() !== ''
        ? Number(hoursWorked)
        : hoursWorked;

    const worksheetEntry = {
        task,
        hoursWorked: hours,
        date,
        userId,
        email,
        createdAt: new Date()
    };
    const result = await worksheetCollection.insertOne(worksheetEntry);
    if (!result.insertedId) {
        throw new Error('Failed to create worksheet entry');
    }
    res.status(201).json({
        message: 'Worksheet entry created successfully',
        entry: { ...worksheetEntry, _id: result.insertedId }
    });
}));

// Endpoint to get worksheet entries for a specific employee
app.get('/worksheet/:email', requireUserOrAdmin, requireStringParam('email', MAXLEN.email), requireSelf('email'), requireDb, asyncHandler(async (req, res) => {
    const entries = await worksheetCollection
        .find({ email: req.params.email })
        .sort({ date: -1 })
        .limit(INTERNAL_FETCH_CAP)
        .toArray();
    res.status(200).json(entries);
}));

// Endpoint to update a worksheet entry
app.put('/worksheet/:id', requireAdmin, requireObjectIdParam('id'), validateWorksheetUpdate, requireDb, asyncHandler(async (req, res) => {
    // Only these fields can be written. _id and anything else are ignored.
    const { task, hoursWorked, date, userId, email } = req.body || {};
    const updateFields = {};

    if (task !== undefined) {
        updateFields.task = task;
    }
    if (hoursWorked !== undefined) {
        updateFields.hoursWorked = typeof hoursWorked === 'string' && hoursWorked.trim() !== ''
            ? Number(hoursWorked)
            : hoursWorked;
    }
    if (date !== undefined) {
        updateFields.date = date;
    }
    if (userId !== undefined) {
        updateFields.userId = userId;
    }
    if (email !== undefined) {
        updateFields.email = email;
    }
    if (Object.keys(updateFields).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await worksheetCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: updateFields }
    );

    if (result.modifiedCount === 0) {
        return res.status(404).json({ error: 'Entry not found or no changes made' });
    }

    res.status(200).json({ message: 'Entry updated successfully' });
}));

// Endpoint to get all worksheet entries
app.get('/worksheet', requireAdmin, validateListQuery, requireDb, asyncHandler(async (req, res) => {
    const entries = await worksheetCollection
        .find({})
        .sort({ date: -1 })
        .limit(parseLimit(req.query.limit))
        .toArray();
    res.status(200).json(entries);
}));

// Endpoint to delete a worksheet entry
app.delete('/worksheet/:id', requireAdmin, requireObjectIdParam('id'), requireDb, asyncHandler(async (req, res) => {
    const result = await worksheetCollection.deleteOne({
        _id: new ObjectId(req.params.id)
    });
    if (result.deletedCount === 0) {
        return res.status(404).json({ error: 'Entry not found' });
    }
    res.status(200).json({ message: 'Entry deleted successfully' });
}));

// Modified salary history endpoint with pagination
app.get('/payment-history', requireAdmin, validateListQuery, requireDb, asyncHandler(async (req, res) => {
    const paymentHistory = await paymentRequestsCollection
        .find()
        .sort({ paidDate: -1 })
        .limit(parseLimit(req.query.limit))
        .toArray();

    res.status(200).json({
        payments: paymentHistory,
        totalEntries: paymentHistory.length
    });
}));

// Returns total of emplyee with email: email
app.get('/payment-history/:email', requireUserOrAdmin, requireStringParam('email', MAXLEN.email), requireSelf('email'), requireDb, asyncHandler(async (req, res) => {
    const { email } = req.params;

    // Fetch payment history filtered by email
    const paymentHistory = await paymentRequestsCollection
        .find({ email })
        .sort({ paidDate: -1 })
        .limit(INTERNAL_FETCH_CAP)
        .toArray();

    if (!paymentHistory || paymentHistory.length === 0) {
        return res.status(404).json({ error: 'No payment history found for this email' });
    }

    // Transform the payment history into the desired format
    const salaryHistory = paymentHistory.map(payment => {
        const paidDate = new Date(payment.paidDate);
        const month = paidDate.toLocaleString('default', { month: 'long' });
        const year = paidDate.getFullYear();
        const monthKey = `${month}-${year}`;

        return {
            month: monthKey,
            salary: payment.amount,
            approvedBy: payment.paidBy
        };
    });

    // Group the payments by month (if multiple payments in the same month)
    const groupedSalaryHistory = salaryHistory.reduce((acc, curr) => {
        const existing = acc.find(item => item.month === curr.month);
        if (existing) {
            existing.salary += curr.salary;
        } else {
            acc.push(curr);
        }
        return acc;
    }, []);

    res.status(200).json({
        payments: groupedSalaryHistory,
        totalEntries: groupedSalaryHistory.length
    });
}));

// Returns array of payments for this employee
app.get('/payment-historya/:email', requireUserOrAdmin, requireStringParam('email', MAXLEN.email), requireSelf('email'), requireDb, asyncHandler(async (req, res) => {
    const { email } = req.params;

    const paymentHistory = await paymentRequestsCollection
        .find({ email })
        .sort({ paidDate: -1 })
        .limit(INTERNAL_FETCH_CAP)
        .toArray();

    res.status(200).json({
        payments: paymentHistory,
        totalEntries: paymentHistory.length
    });
}));

// New endpoint to get total amount owed to employee (worksheetcollection)
app.get('/employee-owed/:email', requireUserOrAdmin, requireStringParam('email', MAXLEN.email), requireSelf('email'), requireDb, asyncHandler(async (req, res) => {
    const { email } = req.params;

    // Get all worksheet entries
    const worksheetEntries = await worksheetCollection.find({
        email: email
    }).limit(INTERNAL_FETCH_CAP).toArray();

    // Get all payment history
    const paymentHistory = await paymentRequestsCollection.find({
        email: email
    }).limit(INTERNAL_FETCH_CAP).toArray();

    // Check for pending payments
    const pendingPayment = await paymentRequestsCollection.findOne({
        email: email,
        status: 'pending'
    });

    // Calculate total hours worked
    const totalHours = worksheetEntries.reduce((acc, entry) => {
        return acc + Number(entry.hoursWorked);
    }, 0);

    // Get paid entries IDs from payment history
    const paidEntryIds = paymentHistory
        .filter(payment => payment.status === 'paid')
        .flatMap(payment => payment.entries || [])
        .map(entry => entry._id.toString());

    // Calculate total paid amount
    const totalPaid = paymentHistory
        .filter(payment => payment.status === 'paid')
        .reduce((acc, payment) => acc + Number(payment.amount), 0);

    // Calculate amount owed (only from unpaid entries)
    const totalOwed = (worksheetEntries
        .filter(entry => !paidEntryIds.includes(entry._id.toString()))
        .reduce((acc, entry) => acc + (Number(entry.hoursWorked) * 20), 0)) - totalPaid;

    // Get the latest paid payment for salary
    const latestPaidPayment = paymentHistory
        .filter(payment => payment.status === 'paid')
        .sort((a, b) => new Date(b.paidDate) - new Date(a.paidDate))[0];

    const salary = latestPaidPayment ? latestPaidPayment.amount : 0;

    res.status(200).json({
        totalOwed,
        totalHours,
        totalPaid,
        salary,
        hasPendingPayment: !!pendingPayment,
        worksheetEntries: worksheetEntries.filter(entry =>
            !paidEntryIds.includes(entry._id.toString())
        )
    });
}));

// Endpoint to process payment
app.post('/process-payment', requireAdmin, validatePaymentBody, requireDb, asyncHandler(async (req, res) => {
    const { email, amount, paidBy, entries } = req.body;

    const amountValue = typeof amount === 'string' && amount.trim() !== '' ? Number(amount) : amount;
    const entryIds = entries.map(entry => new ObjectId(entry._id));

    const session = client.startSession();

    try {
        // Only rows that exist and belong to the claimed employee may be deleted.
        const owned = await worksheetCollection.find({ _id: { $in: entryIds } }).limit(MAXLEN.entries).toArray();
        if (owned.length !== entryIds.length || owned.some(entry => entry.email !== email)) {
            return res.status(400).json({ error: 'entries do not exist or do not belong to that employee' });
        }

        await session.withTransaction(async () => {
            const paymentRecord = {
                email,
                amount: amountValue,
                paidBy,
                paidDate: new Date(),
                status: 'pending',
                entries: entries
            };

            await paymentRequestsCollection.insertOne(paymentRecord, { session });

            await worksheetCollection.deleteMany(
                { _id: { $in: entryIds }, email },
                { session }
            );
        });
    } finally {
        await session.endSession();
    }

    res.status(200).json({ message: 'Payment processed successfully' });
}));

app.get('/check-pending-payment/:email', requireUserOrAdmin, requireStringParam('email', MAXLEN.email), requireSelf('email'), requireDb, asyncHandler(async (req, res) => {
    // Find any pending payments for this employee
    const pendingPayment = await paymentRequestsCollection.findOne({
        email: req.params.email,
        status: 'pending'
    });

    res.status(200).json({
        hasPendingPayment: !!pendingPayment,
        pendingPayment: pendingPayment
    });
}));

// Endpoint for admin to approve/reject payment requests
app.put('/approve-payment/:paymentId', requireAdmin, requireObjectIdParam('paymentId'), validateApprovePaymentBody, requireDb, asyncHandler(async (req, res) => {
    const { paymentId } = req.params;
    const { status } = req.body;

    // Existence check outside the transaction so a miss answers 404 instead of
    // racing the final 200 (the old code could send both).
    const paymentRequest = await paymentRequestsCollection.findOne(
        { _id: new ObjectId(paymentId) }
    );

    if (!paymentRequest) {
        return res.status(404).json({ error: 'Payment request not found.' });
    }

    const session = client.startSession();

    try {
        await session.withTransaction(async () => {
            await paymentRequestsCollection.updateOne(
                { _id: new ObjectId(paymentId) },
                { $set: { status } },
                { session }
            );
        });
    } finally {
        await session.endSession();
    }

    res.status(200).json({ message: `Payment status updated to ${status}` });
}));

// ---------------------------------------------------------------------------
// Error handler. Registered after the routes on purpose: an error handler
// placed earlier in the stack never sees route failures.
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
    const requestId = (req && req.id) || crypto.randomUUID();
    console.error(`[${requestId}] Error stack:`, err.stack);
    if (res.headersSent) {
        return next(err);
    }
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON body', requestId });
    }
    const rawStatus = Number(err && (err.status || err.statusCode));
    if (Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 500) {
        return res.status(rawStatus).json({ error: 'Bad request', requestId });
    }
    res.status(500).json({ error: 'Internal server error', requestId });
});

// ---------------------------------------------------------------------------
// Lifecycle. One shutdown path for SIGINT and SIGTERM so the Mongo connection
// actually closes; the old code registered two SIGINT handlers and the second
// one shadowed the cleanup.
// ---------------------------------------------------------------------------
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, closing MongoDB connection`);
    try {
        await client.close();
    } catch (error) {
        console.error('Error closing MongoDB connection:', error.message);
    }
    process.exit(0);
}
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

connectWithRetry();

// Vercel imports the exported app. A plain `node index.js` run listens on a port.
if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server running on PORT: ${port}`);
    });
}

module.exports = app;
// Pure helpers ride along for the verification script; Vercel only needs app.
module.exports.parseLimit = parseLimit;
module.exports.isValidObjectId = isValidObjectId;
module.exports.asyncHandler = asyncHandler;
module.exports.isStr = isStr;
module.exports.isSelfMatch = isSelfMatch;
