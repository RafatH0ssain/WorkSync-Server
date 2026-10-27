# WorkSync Server

Backend for WorkSync, an employee management and payroll app. Express and MongoDB, with Firebase Admin for user lookups. The frontend is a separate repo: [WorkSync-Client](https://github.com/RafatH0ssain/WorkSync-Client).

## What it does

REST API for an HR workflow at a small company:

- User records with admin, HR, and employee roles
- Monthly work worksheets per employee
- Salary adjustments with history
- Payment requests, approval, and payment history
- A support query inbox

One Express file (`index.js`) holds the routes, the MongoDB connection, and CORS config. Data lives in MongoDB collections for users, worksheets, payments, salary history, and queries.

## Run it

Prerequisites: Node.js 18 to 24, a MongoDB database, and a Firebase service-account JSON file kept somewhere outside this repo. (Node 26 breaks at load time on a transitive dependency of firebase-admin.)

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
| `GOOGLE_APPLICATION_CREDENTIALS` | Absolute path to the service-account JSON, outside the repo |

On a host that provides default Google credentials (for example Google Cloud), you can leave `GOOGLE_APPLICATION_CREDENTIALS` unset.

## API

All routes accept and return JSON. There is no authentication header; see the note below.

**Users**

- `GET /users/:uid`: one user by Firebase UID
- `GET /users`: all non-admin users
- `POST /users`: register a user
- `GET /check-user-status/:uid`: whether a user is active or fired
- `POST /fire/:uid`: mark a user fired
- `POST /make-hr/:id`: promote an employee to HR
- `POST /toggle-verification/:id`: toggle a user's verified flag

**Worksheets**

- `POST /worksheet`: add a worksheet entry
- `GET /worksheet/:email`: entries for one employee
- `GET /worksheet`: all entries
- `PUT /worksheet/:id`: edit an entry
- `DELETE /worksheet/:id`: remove an entry

**Salary and payments**

- `POST /adjust-salary/:id`: set a new salary for a user
- `GET /salary-history/:id`: salary adjustment history
- `POST /process-payment`: create a payment request
- `PUT /approve-payment/:paymentId`: approve or reject a payment request
- `GET /check-pending-payment/:email`: pending payment for an employee
- `GET /employee-owed/:email`: unpaid worksheet total for an employee
- `GET /payment-history/:email`: payment history for an employee
- `GET /payment-history`: payment history across employees
- `GET /payment-historya/:email`: legacy alias of the route above, kept for the deployed client

**Queries**

- `POST /submit-query`: submit a support query
- `GET /queries`: list queries, optionally filtered by `?email=`

Example, creating a worksheet entry:

```json
POST /worksheet
{
  "email": "employee@example.com",
  "hoursWorked": 8,
  "date": "2025-01-19"
}
```

## Out of scope

No route checks authentication or authorization. Anyone who can reach the server can call every endpoint, including `POST /fire/:uid` and `PUT /approve-payment/:paymentId`. Role checks and token verification are a known gap. Do not expose this server publicly as-is.

There are no tests and no CI.

## License

MIT. See [LICENSE](LICENSE).
