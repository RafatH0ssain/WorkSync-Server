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

const db = client.db("WorkSync");
const allUsersCollection = db.collection("Users");
const adminCollection = db.collection("AdminUsers");
const hrCollection = db.collection("HRUsers");
const employeeCollection = db.collection("EmployeeUsers");

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

const firebaseAdmin = require('firebase-admin');
firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.applicationDefault()
});

app.post('/fire/:id', async (req, res) => {
    const userId = req.params.id;

    try {
        // Verify the userId is passed correctly
        if (!userId) {
            return res.status(400).json({ error: 'No user ID provided' });
        }

        // Try to disable the Firebase user
        await firebaseAdmin.auth().updateUser(userId, { disabled: true });

        res.status(200).send('User fired successfully');
    } catch (error) {
        console.error('Error firing user:', error);
        res.status(500).json({ error: 'Error firing user' });
    }
});

app.post('/make-hr/:id', async (req, res) => {
    const userId = req.params.id;
    try {
        // Update user type to HR in the database
        await updateUserType(userId, 'hr');
        res.status(200).send('User made HR');
    } catch (error) {
        res.status(500).send('Error making user HR');
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

run().catch(console.dir);