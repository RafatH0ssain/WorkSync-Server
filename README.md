# WorkSync Backend


## Overview
WorkSync's backend is built using **Node.js**, **Express.js**, and **MongoDB**, providing a robust and scalable server for managing employee data, payroll, and user authentication. The API supports role-based access with **JWT authentication** and integrates **Firebase** for secure user management.


## Frontend:
[Github Link](https://github.com/RafatH0ssain/WorkSync-Client)


## 📚 API Documentation

### 👥 User Management

#### 🔍 Get User by UID
**Endpoint:** `GET /users/:uid`  
**Description:** Retrieve details of a specific user by their Firebase UID  
**Response:**  
```json
{
  "_id": "string",
  "name": "string",
  "email": "string",
  "userType": "admin|hr|employee",
  "status": "active|fired",
  "createdAt": "ISO date"
}
```

#### 📋 Get All Users
**Endpoint:** `GET /users`  
**Description:** Get all non-admin users  
**Response:** Array of user objects  

#### 📝 Register User
**Endpoint:** `POST /users`  
**Body:**  
```json
{
  "name": "string",
  "email": "string",
  "photoURL": "string",
  "uid": "string",
  "userType": "admin|hr|employee"
}
```

#### ⬆️ Promote to HR
**Endpoint:** `POST /make-hr/:id`  
**Description:** Promote an employee to HR role  
**Params:** MongoDB document ID  

### ❓ Queries

#### ✉️ Submit Query
**Endpoint:** `POST /submit-query`  
**Body:**  
```json
{
  "heading": "string",
  "designation": "string",
  "details": "string",
  "email": "string"
}
```

#### 📨 Get Queries 
**Endpoint:** `GET /queries`  
**Query Params:** ?email=user@example.com  
**Response:** Array of query objects  

### 📅 Worksheet Management
#### ➕ Create Worksheet Entry
**Endpoint:** `POST /worksheet`  
**Body:**  
```json
{
  "email": "string",
  "hoursWorked": "number",
  "date": "ISO date"
}
```

#### 📂 Get Worksheet Entries
**Endpoint:** `GET /worksheet/:email`  
**Response:** Array of worksheet entries for specified user  

### 💰 Payments
#### 💸 Process Payment
**Endpoint:** `POST /process-payment`  
**Body:**  
```json
{
  "email": "string",
  "amount": "number",
  "paidBy": "string",
  "entries": ["array of entry IDs"]
}
```

#### 📊 Get Payment History
**Endpoint:** `GET /payment-history/:email`  
**Response:**  
```json
{
  "payments": [
    {
      "month": "string",
      "salary": "number",
      "approvedBy": "string"
    }
  ]
}
```

#### ⏳ Check Pending Payments
**Endpoint:** `GET /check-pending-payment/:email`  
**Response:**  
```json
{
  "hasPendingPayment": "boolean",
  "pendingPayment": "object|null"
}
```

### 💼 Salary Management
#### 📈 Adjust Salary
**Endpoint:** `POST /adjust-salary/:id`  
**Params:** MongoDB document ID  
**Body:**  
```json
{ "salary": "number" }
```

### 📜 Get Salary History
**Endpoint:** `GET /salary-history/:id`  
**Response:** Array of salary adjustment objects  


## 📬 Contact
For any questions or support, please contact:

📧 [Email](mailto:rafat.click.hossain@gmail.com)

👔 [LinkedIn](https://www.linkedin.com/in/muhammad-rafat-hossain/)

**Let's connect! 🤝**