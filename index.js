require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
// Add this at the start of your backend file to verify env variables
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PW}@cluster0.oyqb2.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Middleware
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
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true, // This is crucial
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

app.use((err, req, res, next) => {
    console.error("Error stack:", err.stack); // Log the full error stack
    res.status(500).json({ error: 'Something broke!', details: err.message });
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
const paymentRequestsCollection = db.collection("PaymentRequests");
const worksheetCollection = db.collection("EmployeeWorksheets");
const queriesCollection = db.collection("Queries");

app.post('/submit-query', async (req, res) => {
    try {
        const { heading, designation, details, submittedAt, email } = req.body;

        // Create query document
        const queryDocument = {
            heading,
            designation,
            details,
            email,
            status: 'pending',
            submittedAt: new Date(submittedAt),
            updatedAt: new Date()
        };

        // Insert into Queries collection
        const result = await queriesCollection.insertOne(queryDocument);

        if (!result.insertedId) {
            throw new Error('Failed to insert query');
        }

        res.status(201).json({
            message: 'Query submitted successfully',
            queryId: result.insertedId
        });

    } catch (error) {
        console.error('Error submitting query:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/queries', async (req, res) => {
    try {
        const { email } = req.query;

        const filter = {};
        if (email) {
            filter.email = email;
        }

        const queries = await queriesCollection
            .find(filter)
            .sort({ submittedAt: -1 })
            .toArray();

        res.status(200).json(queries);
    } catch (error) {
        console.error('Error fetching queries:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

async function run() {
    try {
        await client.connect(); // Ensure this is uncommented

        // Test the connection
        const pingResult = await client.db("admin").command({ ping: 1 });
        console.log("MongoDB connection successful!", pingResult);

        // Start the server only after successful connection
        app.listen(port, () => {
            console.log(`Server running on PORT: ${port}`);
        });
    } catch (error) {
        console.error("Error connecting to MongoDB:", error);
        process.exit(1);
    }
}

// Proper cleanup
process.on('SIGINT', async () => {
    await client.close(); // Ensure this is uncommented
    process.exit();
});

// Proper cleanup
process.on('SIGINT', async () => {
    // await client.close();
    process.exit();
});

// GET method for getting the current logged in user
app.get('/users/:uid', async (req, res) => {
    const { uid } = req.params;

    try {
        const user = await allUsersCollection.findOne({ uid: uid });

        // Add cache control headers
        res.setHeader('Cache-Control', 'no-store, max-age=0');

        if (user) {
            res.status(200).json(user);
        } else {
            res.status(404).json({ error: 'No record found' });
        }
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET method for getting all users excluding admin
app.get('/users', async (req, res) => {
    try {
        const users = await allUsersCollection.find({
            userType: { $ne: "admin" }
        }).toArray();

        // Always return 200 with array
        res.status(200).json(users || []);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            details: error.message
        });
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

        // Add CORS headers explicitly
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control');
        res.header('Access-Control-Allow-Origin', 'https://worksync-2ca3b.web.app');
        res.header('Access-Control-Allow-Credentials', 'true');

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.status(200).json({
            status: user.status || 'active',
            userType: user.userType
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
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

// Get salary history for an employee
app.get('/salary-history/:id', async (req, res) => {
    try {
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

// Endpoint to add a new worksheet entry
app.post('/worksheet', async (req, res) => {
    try {
        const worksheetEntry = {
            ...req.body,
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
    } catch (error) {
        console.error('Error creating worksheet entry:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint to get worksheet entries for a specific employee
app.get('/worksheet/:email', async (req, res) => {
    try {
        const entries = await worksheetCollection
            .find({ email: req.params.email })
            .sort({ date: -1 })
            .toArray();
        res.status(200).json(entries);
    } catch (error) {
        console.error('Error fetching worksheet entries:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint to update a worksheet entry
app.put('/worksheet/:id', async (req, res) => {
    try {
        // Ensure that we're not modifying the _id field itself (it should stay as-is)
        const { _id, ...updateFields } = req.body;

        // Proceed with the update, ensuring the _id remains unchanged
        const result = await worksheetCollection.updateOne(
            { _id: new ObjectId(req.params.id) }, // Match the document by _id
            { $set: updateFields } // Only set the fields provided, excluding _id
        );

        // Check if any document was modified
        if (result.modifiedCount === 0) {
            return res.status(404).json({ error: 'Entry not found or no changes made' });
        }

        res.status(200).json({ message: 'Entry updated successfully' });
    } catch (error) {
        console.error('Error updating worksheet entry:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint to get all worksheet entries
app.get('/worksheet', async (req, res) => {
    try {
        const entries = await worksheetCollection
            .find({})
            .sort({ date: -1 })
            .toArray();
        res.status(200).json(entries);
    } catch (error) {
        console.error('Error fetching worksheet entries:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint to delete a worksheet entry
app.delete('/worksheet/:id', async (req, res) => {
    try {
        const result = await worksheetCollection.deleteOne({
            _id: new ObjectId(req.params.id)
        });
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Entry not found' });
        }
        res.status(200).json({ message: 'Entry deleted successfully' });
    } catch (error) {
        console.error('Error deleting worksheet entry:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Modified salary history endpoint with pagination
app.get('/payment-history', async (req, res) => {
    try {
        // Fetch all payment requests from the collection
        const paymentHistory = await paymentRequestsCollection
            .find()
            .sort({ paidDate: -1 })
            .toArray();

        res.status(200).json({
            payments: paymentHistory,
            totalEntries: paymentHistory.length
        });
    } catch (error) {
        console.error('Error fetching payment history:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Returns total of emplyee with email: email
app.get('/payment-history/:email', async (req, res) => {
    try {
        const { email } = req.params; // Get email from the URL parameter

        if (!email) {
            return res.status(400).json({ error: 'Email is required' }); // Return error if email is not provided
        }

        // Fetch payment history filtered by email
        const paymentHistory = await paymentRequestsCollection
            .find({ email }) // Filter by email
            .sort({ paidDate: -1 })
            .toArray(); // Ensure toArray() is called to return an array

        if (!paymentHistory || paymentHistory.length === 0) {
            return res.status(404).json({ error: 'No payment history found for this email' });
        }

        // Transform the payment history into the desired format
        const salaryHistory = paymentHistory.map(payment => {
            // Extract month and year from paidDate
            const paidDate = new Date(payment.paidDate);
            const month = paidDate.toLocaleString('default', { month: 'long' });
            const year = paidDate.getFullYear();

            // Combine month and year for unique month-key
            const monthKey = `${month}-${year}`;

            // You can accumulate the total amount for the month if there are multiple payments in the same month
            return {
                month: monthKey,
                salary: payment.amount, // The amount paid as the salary for this entry
                approvedBy: payment.paidBy
            };
        });

        // Group the payments by month (if multiple payments in the same month)
        const groupedSalaryHistory = salaryHistory.reduce((acc, curr) => {
            const existing = acc.find(item => item.month === curr.month);
            if (existing) {
                existing.salary += curr.salary; // Accumulate salary for the same month
            } else {
                acc.push(curr); // Add new month entry
            }
            return acc;
        }, []);

        // Return the transformed payment history data
        res.status(200).json({
            payments: groupedSalaryHistory,
            totalEntries: groupedSalaryHistory.length
        });
    } catch (error) {
        console.error('Error fetching payment history:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Returns array of payments for this employee
app.get('/payment-historya/:email', async (req, res) => {
    try {
        const { email } = req.params; // Get email from the URL parameter

        if (!email) {
            return res.status(400).json({ error: 'Email is required' }); // Return error if email is not provided
        }

        // Fetch payment history filtered by email
        const paymentHistory = await paymentRequestsCollection
            .find({ email }) // Filter by email
            .sort({ paidDate: -1 })
            .toArray();

        res.status(200).json({
            payments: paymentHistory,
            totalEntries: paymentHistory.length
        });
    } catch (error) {
        console.error('Error fetching payment history:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// New endpoint to get total amount owed to employee (worksheetcollection)
app.get('/employee-owed/:email', async (req, res) => {
    try {
        const { email } = req.params;

        // Get all worksheet entries
        const worksheetEntries = await worksheetCollection.find({
            email: email
        }).toArray();

        // Get all payment history
        const paymentHistory = await paymentRequestsCollection.find({
            email: email
        }).toArray();

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
    } catch (error) {
        console.error('Error calculating employee metrics:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint to process payment
app.post('/process-payment', async (req, res) => {
    const { email, amount, paidBy, entries } = req.body;

    const session = client.startSession();

    try {
        await session.withTransaction(async () => {
            // Create payment record
            const paymentRecord = {
                email,
                amount,
                paidBy,
                paidDate: new Date(),
                status: 'pending',
                entries: entries // Store the worksheet entries that were paid
            };

            await paymentRequestsCollection.insertOne(paymentRecord, { session });

            // Delete the paid worksheet entries
            const entryIds = entries.map(entry => new ObjectId(entry._id));
            await worksheetCollection.deleteMany(
                { _id: { $in: entryIds } },
                { session }
            );
        });

        res.status(200).json({ message: 'Payment processed successfully' });
    } catch (error) {
        console.error('Error processing payment:', error);
        res.status(500).json({ error: 'Failed to process payment' });
    } finally {
        await session.endSession();
    }
});

app.get('/check-pending-payment/:email', async (req, res) => {
    try {
        const { email } = req.params;

        // Find any pending payments for this employee
        const pendingPayment = await paymentRequestsCollection.findOne({
            email: email,
            status: 'pending'
        });

        res.status(200).json({
            hasPendingPayment: !!pendingPayment,
            pendingPayment: pendingPayment
        });
    } catch (error) {
        console.error('Error checking pending payments:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint for admin to approve/reject payment requests
app.put('/approve-payment/:paymentId', async (req, res) => {
    const { paymentId } = req.params;
    const { status } = req.body; // 'paid' or 'pending'

    if (!['paid', 'pending'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status value. Must be "paid" or "pending".' });
    }

    const session = client.startSession();

    try {
        // Start a transaction to ensure consistency
        await session.withTransaction(async () => {
            const paymentRequest = await paymentRequestsCollection.findOne(
                { _id: new ObjectId(paymentId) },
                { session }
            );

            if (!paymentRequest) {
                return res.status(404).json({ error: 'Payment request not found.' });
            }

            // Update the payment status
            await paymentRequestsCollection.updateOne(
                { _id: new ObjectId(paymentId) },
                { $set: { status } },
                { session }
            );

            // If payment is approved, you may also take additional actions like triggering a notification or logging.
            if (status === 'paid') {
                // Any logic to process once payment is approved (e.g., notify HR, employees, etc.)
            }
        });

        res.status(200).json({ message: `Payment status updated to ${status}` });
    } catch (error) {
        console.error('Error updating payment status:', error);
        res.status(500).json({ error: 'Failed to update payment status.' });
    } finally {
        await session.endSession();
    }
});

run().catch(console.dir);
module.exports = app;