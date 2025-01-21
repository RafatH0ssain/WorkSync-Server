require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
// Add this at the start of your backend file to verify env variables
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PW}@cluster0.oyqb2.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Middleware
app.use(cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true
}));
app.use(express.json());

// Add this before your routes
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something broke!' });
});

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

const admin = require('firebase-admin');
const serviceAccount = require('./worksync-2ca3b-firebase-adminsdk-sxxrh-0adbd0d0d3.json'); // Ensure this is the correct path to your service account key

// Initialize Firebase Admin SDK with service account
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = client.db("WorkSync");
const allUsersCollection = db.collection("Users");
const adminCollection = db.collection("AdminUsers");
const hrCollection = db.collection("HRUsers");
const employeeCollection = db.collection("EmployeeUsers");
const employeePaymentCollection = db.collection("EmployeePayments");

async function run() {
    try {
        await client.connect();

        // Test the connection
        const pingResult = await client.db("admin").command({ ping: 1 });
        console.log("MongoDB connection successful!", pingResult);

        // Start the server only after successful connection
        app.listen(port, () => {
            console.log(`Server running on PORT: ${port}`);
        });

        // Add this after your MongoDB connection
        const db = client.db("WorkSync");
        const collections = {
            allUsers: db.collection("Users"),
            admin: db.collection("AdminUsers"),
            hr: db.collection("HRUsers"),
            employee: db.collection("EmployeeUsers")
        };

        // Remove this line since uid is not defined here
        // const user = await collections.allUsers.findOne({ uid: uid });
    }
    catch (error) {
        console.error("Error connecting to MongoDB:", error);
        process.exit(1);
    }
}

// Add this for proper cleanup
process.on('SIGINT', async () => {
    await client.close();
    process.exit();
});

// GET method for getting the current logged in user
app.get('/users/:uid', async (req, res) => {
    const { uid } = req.params;

    try {
        const user = await allUsersCollection.findOne({ uid: uid });
        if (user) {
            res.status(200).json(user);
        } else {
            res.status(404).json({ error: 'No record found with that UID' });
        }
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET method for getting all users excluding admin
app.get('/users', async (req, res) => {
    try {
        // Fetch all users except those with userType 'admin'
        const users = await allUsersCollection.find({ userType: { $ne: "admin" } }).toArray();
        if (users.length > 0) {
            res.status(200).json(users);
        } else {
            res.status(404).json({ error: 'No users found' });
        }
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/users', async (req, res) => {
    const { name, email, photoURL, uid, userType } = req.body;

    try {
        // Check if the user already exists
        const existingUser = await allUsersCollection.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ message: "User already exists!" });
        }

        // Prepare the new user object, without the _id field as MongoDB generates it automatically
        const newUser = {
            name,
            email,
            photoURL,
            uid,
            userType,
            createdAt: new Date(),  // Ensure this is stored as a Date object
        };

        // Insert the user into the appropriate collection based on userType
        let collection;
        switch (newUser.userType) {
            case "admin":
                collection = adminCollection;
                break;
            case "hr":
                collection = hrCollection;
                break;
            case "employee":
            default:
                collection = employeeCollection;
                break;
        }

        // Insert the new user into the correct collection
        await collection.insertOne(newUser);
        await allUsersCollection.insertOne(newUser);

        res.status(201).json({ message: "User registered successfully!" });
    } catch (error) {
        console.error("Error saving user:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// const firebaseAdmin = require('firebase-admin');
// firebaseAdmin.initializeApp({
//     credential: firebaseAdmin.credential.applicationDefault()
// });

// Modify the fire endpoint in your backend
app.post('/fire/:uid', async (req, res) => {
    const userId = req.params.uid;

    try {
        if (!userId) {
            return res.status(400).json({ error: 'No user ID provided' });
        }

        console.log('Firing user:', userId);

        // First find the user to determine their type
        const user = await allUsersCollection.findOne({ uid: userId });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Determine which specific collection to update based on user type
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

        // Update both the specific collection and the main Users collection
        const updatePromises = [
            // Update in specific collection (HR, Admin, or Employee)
            specificCollection.updateOne(
                { uid: userId },
                { $set: { status: 'fired' } }
            ),
            // Update in main Users collection
            allUsersCollection.updateOne(
                { uid: userId },
                { $set: { status: 'fired' } }
            )
        ];

        await Promise.all(updatePromises);

        // Fetch the updated user to verify the change
        const updatedUser = await allUsersCollection.findOne({ uid: userId });

        // Fetch the updated lists to send back to frontend
        const updatedUsers = await allUsersCollection.find({}).toArray();

        res.status(200).json({
            message: 'User fired successfully',
            user: updatedUser,
            updatedUsers: updatedUsers
        });

    } catch (error) {
        console.error('Error firing user:', error);
        res.status(500).json({ error: `Error firing user: ${error.message}` });
    }
});

// Add a new endpoint to check user status during login
app.get('/check-user-status/:uid', async (req, res) => {
    const userId = req.params.uid;

    try {
        const user = await allUsersCollection.findOne({ uid: userId });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.status(200).json({
            status: user.status || 'active',
            userType: user.userType
        });
    } catch (error) {
        console.error('Error checking user status:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Enhanced make-hr endpoint
app.post('/make-hr/:id', async (req, res) => {
    const userId = req.params.id;

    try {
        // First, find the user in the main Users collection
        const user = await allUsersCollection.findOne({ _id: new ObjectId(userId) });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Create user object for HR collection
        const hrUser = {
            ...user,
            userType: 'hr',
            promotedAt: new Date()
        };

        // Start a session for transaction
        const session = client.startSession();

        try {
            await session.withTransaction(async () => {
                // Remove from employee collection if they were an employee
                if (user.userType === 'employee') {
                    await employeeCollection.deleteOne({ _id: new ObjectId(userId) }, { session });
                }

                // Insert into HR collection
                await hrCollection.insertOne(hrUser, { session });

                // Update main Users collection
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

            // Fetch updated user list
            const updatedUsers = await allUsersCollection
                .find({ userType: { $ne: "admin" } })
                .toArray();

            res.status(200).json({
                message: 'User successfully promoted to HR',
                updatedUsers: updatedUsers
            });

        } finally {
            await session.endSession();
        }

    } catch (error) {
        console.error('Error promoting user to HR:', error);
        res.status(500).json({ error: 'Internal server error while promoting user' });
    }
});

app.post('/adjust-salary/:id', async (req, res) => {
    const userId = req.params.id;
    const { salary } = req.body;
    try {
        // Update salary in the database
        await adjustSalary(userId, salary);
        res.status(200).send('Salary adjusted');
    } catch (error) {
        res.status(500).send('Error adjusting salary');
    }
});

// Add these routes to your backend file

// Toggle employee verification status
app.post('/toggle-verification/:id', async (req, res) => {
    const { id } = req.params;
    const { isVerified } = req.body;

    try {
        const result = await allUsersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { isVerified } }
        );

        if (result.modifiedCount === 0) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        res.status(200).json({ message: 'Verification status updated successfully' });
    } catch (error) {
        console.error('Error updating verification status:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create payment request
app.post('/payment-requests', async (req, res) => {
    try {
        const paymentRequest = {
            ...req.body,
            requestDate: new Date(),
            status: 'pending',
            requestedBy: req.body.hrId, // ID of HR making request
        };

        // Create payment requests collection if it doesn't exist
        const paymentRequestsCollection = db.collection("PaymentRequests");

        const result = await paymentRequestsCollection.insertOne(paymentRequest);

        if (!result.insertedId) {
            throw new Error('Failed to create payment request');
        }

        res.status(201).json({
            message: 'Payment request created successfully',
            requestId: result.insertedId
        });
    } catch (error) {
        console.error('Error creating payment request:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get salary history for an employee
app.get('/salary-history/:id', async (req, res) => {
    try {
        const paymentRequestsCollection = db.collection("PaymentRequests");

        // Get approved payments for the employee
        const salaryHistory = await paymentRequestsCollection
            .find({
                employeeId: req.params.id,
                status: 'approved'
            })
            .sort({ year: 1, month: 1 })
            .toArray();

        // Transform data for the chart
        const formattedHistory = salaryHistory.map(payment => ({
            month: `${payment.month} ${payment.year}`,
            salary: payment.salary
        }));

        res.status(200).json(formattedHistory);
    } catch (error) {
        console.error('Error fetching salary history:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get employee details by ID
app.get('/users/:id', async (req, res) => {
    try {
        const user = await allUsersCollection.findOne({
            _id: new ObjectId(req.params.id)
        });

        if (!user) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        res.status(200).json(user);
    } catch (error) {
        console.error('Error fetching employee details:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

run().catch(console.dir);