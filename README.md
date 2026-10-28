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

Prerequisites: Node.js 18 to 24 and a MongoDB database.

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
| `ADMIN_TOKEN` | Shared secret for admin routes. Empty or absent disables them (503). |
| `GOOGLE_APPLICATION_CREDENTIALS` | Reserved for future Firebase token verification. Unused today. |

`GET /` reports whether the process is up and whether MongoDB is reachable. The server keeps running when MongoDB is down and answers 503 on data routes until the connection succeeds.

## Security boundary

There is no per-user identity system yet. Privileged routes run behind a shared secret instead:

- Set `ADMIN_TOKEN` to a long random value.
- Callers of protected routes send the matching `x-admin-token` request header.
- With `ADMIN_TOKEN` empty or absent, every protected route returns 503 with a message that admin operations are disabled. This is the default, so a fresh deployment starts out safe.

Protected routes are every POST, PUT, and DELETE route, plus the bulk reads `GET /users`, `GET /worksheet`, `GET /payment-history`, `GET /queries`, and `GET /salary-history/:id`. A missing or wrong token returns 401. The deployed client does not send the header yet, so its registration form, contact form, and admin pages need the header added before they work again.

What the boundary enforces on specific routes:

- `POST /users` only ever creates employee records. `userType` values other than `employee` are rejected with 400, so nobody can register as admin or HR through it. Promote employees to HR with `POST /make-hr/:id`.
- `POST /process-payment` deletes worksheet rows, so it needs the token and validates the request first: `entries` must be existing worksheet rows that belong to the claimed employee. Rows that fail that check are never deleted.
- `POST /worksheet` and `PUT /worksheet/:id` accept only the fields the app uses (`task`, `hoursWorked`, `date`, `userId`, `email`).
- `POST /adjust-salary/:id` returns 501 Not Implemented. It stays unimplemented on purpose until it can be reviewed.

Open routes are the single-record reads the client needs for its own pages (`GET /users/:uid`, `GET /worksheet/:email`, and the other per-employee lookups) plus `GET /`. Anyone who knows an employee's email or uid can still read that one employee's data through them. Closing that needs real per-user auth.

Error responses carry a generic message and a `requestId`. The real error goes to the server log, keyed by the same id.

## API

All routes accept and return JSON. Protected routes need the `x-admin-token` header (see above).

**Users**

- `GET /users/:uid`: one user by Firebase UID (open)
- `GET /users`: all non-admin users (protected)
- `POST /users`: register an employee (protected, employees only)
- `GET /check-user-status/:uid`: whether a user is active or fired (open)
- `POST /fire/:uid`: mark a user fired (protected)
- `POST /make-hr/:id`: promote an employee to HR (protected)
- `POST /toggle-verification/:id`: toggle a user's verified flag (protected)

**Worksheets**

- `POST /worksheet`: add a worksheet entry (protected)
- `GET /worksheet/:email`: entries for one employee (open)
- `GET /worksheet`: all entries (protected)
- `PUT /worksheet/:id`: edit an entry (protected)
- `DELETE /worksheet/:id`: remove an entry (protected)

**Salary and payments**

- `POST /adjust-salary/:id`: returns 501 Not Implemented (protected)
- `GET /salary-history/:id`: salary adjustment history (protected)
- `POST /process-payment`: create a payment request and clear the paid rows (protected)
- `PUT /approve-payment/:paymentId`: approve or reject a payment request (protected)
- `GET /check-pending-payment/:email`: pending payment for an employee (open)
- `GET /employee-owed/:email`: unpaid worksheet total for an employee (open)
- `GET /payment-history/:email`: payment history for an employee (open)
- `GET /payment-history`: payment history across employees (protected)
- `GET /payment-historya/:email`: legacy alias kept for the deployed client (open)

**Queries**

- `POST /submit-query`: submit a support query (protected)
- `GET /queries`: list queries, optionally filtered by `?email=` (protected)

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

`npm test` runs `verify-security.sh`. It boots the server with dummy env vars and checks that the server comes up without Google credentials, that protected routes refuse requests without the token, that `userType: "admin"` on registration is rejected, and that the `POST /process-payment` guard holds. It needs `node` and `curl` and touches no real data.

## Out of scope

No per-user authentication or authorization. The `x-admin-token` header is one shared secret for the whole admin surface, not a user identity, and the open single-record reads still expose one employee's data to anyone who knows their email or uid. Server-side role checks that verify real user tokens are a known gap.

## License

MIT. See [LICENSE](LICENSE).
