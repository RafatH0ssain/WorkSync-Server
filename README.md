# WorkSync Server

Backend for WorkSync, an employee management and payroll app. Express and MongoDB. The frontend is a separate repo: [WorkSync-Client](https://github.com/RafatH0ssain/WorkSync-Client).

## What it does

REST API for an HR workflow at a small company:

- User records with admin, HR, and employee roles
- Monthly work worksheets per employee
- Salary adjustments with history
- Payment requests, approval, and payment history
- A support query inbox

One Express file (`index.js`) holds the routes, the MongoDB connection, and CORS config. Data lives in MongoDB collections for users, worksheets, payments, salary history, and queries.

## Run it

Prerequisites: Node.js 22 or newer and a MongoDB database.

```bash
npm install
cp .env.example .env   # fill in the values
npm start
```

`.env` variables:

| Variable | Meaning |
| --- | --- |
| `PORT` | Port to listen on. Defaults to 5000. |
| `DB_USER`, `DB_PW` | MongoDB credentials |
| `MONGO_URI` | Full MongoDB connection string. When set it wins over the pieces below. |
| `MONGO_CLUSTER` | Atlas hostname. Defaults to `cluster0.oyqb2.mongodb.net`. |
| `ADMIN_TOKEN` | Shared secret for admin routes. Empty or absent disables them (503). |
| `RATE_LIMIT_MAX` | Requests per client address per minute. Defaults to 120. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a Firebase service-account key file outside the repo. Used to verify ID tokens. |
| `FIREBASE_SERVICE_ACCOUNT` | The same key JSON as a string, for hosts that hold no key file. |

`GET /` reports whether the process is up and whether MongoDB is reachable. It only reads a cached flag, so it stays cheap and never touches the database. The server keeps running when MongoDB is down and answers 503 on data routes until the connection succeeds.

## Security boundary

Two credentials cover the API and both stay active.

**Per user: `Authorization: Bearer <firebase-id-token>`.** The server verifies the token with Firebase Admin. A verified caller reads only their own record: the uid or email in the route must match the token, with emails compared case-insensitively. A missing, expired or wrong token answers 401. A token that names a different record answers 403.

**Admin: `x-admin-token`.** Callers send the shared secret stored in `ADMIN_TOKEN`. It opens the admin routes and the single-record reads, where it may read any record. With `ADMIN_TOKEN` empty or absent, the admin routes return 503 with a message that admin operations are disabled. A missing or wrong header answers 401.

The single-record reads take either credential. `x-admin-token` covers every POST, PUT and DELETE route except `POST /users` (signup) and `POST /submit-query` (contact form), plus the bulk reads `GET /users`, `GET /worksheet`, `GET /payment-history`, `GET /queries` and `GET /salary-history/:id`. Those two writes and `GET /` take no credential.

Firebase credentials load at boot in this order:

1. `GOOGLE_APPLICATION_CREDENTIALS` pointing at a key file outside the repo
2. Application Default Credentials on Google Cloud
3. `FIREBASE_SERVICE_ACCOUNT` holding the key JSON as a string (Vercel)

When none of them is usable the server still boots, logs that ID-token auth is disabled, and answers 401 on the ID-token routes. The `x-admin-token` path is unaffected.

What the boundary enforces on specific routes:

- `POST /users` only ever creates employee records. `userType` values other than `employee` are rejected with 400, so nobody can register as admin or HR through it. Promote employees to HR with `POST /make-hr/:id`.
- `POST /process-payment` deletes worksheet rows, so it needs the token and validates the request first: `entries` must be existing worksheet rows that belong to the claimed employee. Rows that fail that check are never deleted.
- `POST /worksheet` and `PUT /worksheet/:id` accept only the fields the app uses (`task`, `hoursWorked`, `date`, `userId`, `email`).
- `POST /adjust-salary/:id` takes `newSalary`, a number from 0 up to 100000. It writes that value to the employee's salary field and appends a row to the `SalaryHistory` collection with the previous value, the new value, the time and the credential that made the change.

Error responses carry a generic message and a `requestId`. The real error goes to the server log, keyed by the same id. Every response also carries `X-Request-Id`, and each request is logged on completion with its method, path, status and duration.

### Roles

The server never reads a role out of the request. There is no role header and no role claim in any body that changes what a caller may do. Privileged routes are gated by the `x-admin-token` secret alone. When a role is written to the database (`userType` on registration, on promotion to HR) the value is decided server side: `POST /users` stores `userType: "employee"` always, `POST /make-hr/:id` is the only way to write `userType: "hr"`, and no route can write `userType: "admin"`. Role checks on the client are UI convenience only.

### Input validation

Every `req.params`, `req.query` and `req.body` value that reaches a database query is type checked and length capped before the database gate runs, so bad input answers 400 even while MongoDB is down:

- Ids used as `ObjectId` must be 24 hex characters. `new ObjectId(undefined)` would otherwise mint a fresh id, and operator objects must never reach a cast.
- Strings are checked with `typeof === "string"` and a per field length cap, so query operators like `{"$gt": ""}` in `email` are rejected rather than executed.
- List endpoints accept `?limit=`, a positive integer capped at 200. Collection reads default to 200 rows and never stream a whole collection to the client.
- JSON bodies are capped at 100 KB.

### Rate limits

Each client address gets `RATE_LIMIT_MAX` requests per minute (default 120) across the API. Over budget answers 429 with a `Retry-After` header. `GET /` is exempt so health probes keep working. The limiter is in memory and per process; running several instances needs a shared store for a single global budget.

### Response headers

Every response sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and `Cache-Control: no-store`.

## API

All routes accept and return JSON. Each route line names the credential it takes (see Security boundary).

**Users**

- `GET /users/:uid`: one user by Firebase UID (own record or admin token)
- `GET /users`: all non-admin users (admin token, `?limit=` capped at 200)
- `POST /users`: register an employee (public; always writes `userType: "employee"`)
- `GET /check-user-status/:uid`: whether a user is active or fired (own record or admin token)
- `POST /fire/:uid`: mark a user fired (admin token)
- `POST /make-hr/:id`: promote an employee to HR (admin token)
- `POST /toggle-verification/:id`: toggle a user's verified flag (admin token)

**Worksheets**

- `POST /worksheet`: add a worksheet entry (admin token)
- `GET /worksheet/:email`: entries for one employee (own record or admin token)
- `GET /worksheet`: all entries (admin token, `?limit=` capped at 200)
- `PUT /worksheet/:id`: edit an entry (admin token)
- `DELETE /worksheet/:id`: remove an entry (admin token)

**Salary and payments**

- `POST /adjust-salary/:id`: set an employee's salary and append to the salary history (admin token; body `{"newSalary": 5000}`)
- `GET /salary-history/:id`: salary history for an employee (admin token)
- `POST /process-payment`: create a payment request and clear the paid rows (admin token)
- `PUT /approve-payment/:paymentId`: approve or reject a payment request (admin token)
- `GET /check-pending-payment/:email`: pending payment for an employee (own record or admin token)
- `GET /employee-owed/:email`: unpaid worksheet total for an employee (own record or admin token)
- `GET /payment-history/:email`: payment history for an employee (own record or admin token)
- `GET /payment-history`: payment history across employees (admin token, `?limit=` capped at 200)
- `GET /payment-historya/:email`: alias kept for the deployed client (own record or admin token)

**Queries**

- `POST /submit-query`: submit a support query (public)
- `GET /queries`: list queries, optionally filtered by `?email=` (admin token, `?limit=` capped at 200)

Example, creating a worksheet entry:

```json
POST /worksheet
{
  "task": "Sales",
  "hoursWorked": 8,
  "date": "2025-01-19",
  "userId": "firebase-uid",
  "email": "employee@example.com"
}
```

## Tests

`npm test` runs `verify-security.sh`. It boots the server with dummy env vars (no MongoDB, no Google credentials) and checks, without touching real data:

- the server boots and answers with JSON while the database is down
- admin routes refuse requests without a valid `x-admin-token`
- single-record reads answer 401 without `Authorization` and for a garbage Bearer token, and the admin token still opens them
- `POST /users` and `POST /submit-query` stay open
- `POST /adjust-salary/:id` needs the admin token and a `newSalary` in range
- `userType: "admin"` on registration is rejected
- the `POST /process-payment` ownership guard holds
- operator-object and junk ObjectId injections are rejected with 400
- list endpoints cap scans and reject a bad `?limit=`
- security headers and the preflight allowances for `x-admin-token` and `Authorization` are present
- the rate limiter returns 429 over budget while health checks stay exempt
- an async handler rejection answers 500 and leaves the process alive
- the boot log marks ID-token auth as disabled when no Firebase credentials are set

It needs `node` and `curl`.

## License

MIT. See [LICENSE](LICENSE).
