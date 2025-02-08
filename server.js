const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@libsql/client');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const ImageKit = require("imagekit");
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { google } = require("googleapis");
const nodemailer = require('nodemailer');

require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Database Client Configuration
const client = createClient({
    url: process.env.DATABASE_URL,
    authToken: process.env.AUTH_TOKEN,
});

// Cloudinary Configuration
cloudinary.config({
    cloud_name: process.env.CLOUD_NAME,
    api_key: process.env.API_KEY,
    api_secret: process.env.API_SECRET,
});

// ImageKit configuration
const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
});

// Attendance Config
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DATA_SHEET_ID = process.env.DATA_SHEET_ID; // Add this line for the new route
const SHEET_ID = process.env.SHEET_ID; // support route line developer
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const classSheets = ["Class1", "Class2", "Class3"]; // Add your class sheet names here

// Multer Storage Configuration
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'uploads',
        allowed_formats: ['jpg', 'png'],
    },
});
const upload = multer({ storage: storage });

// Middleware
app.use(bodyParser.json());
app.use(cors());

// Login endpoint
app.post('/login', async (req, res) => {
    const { rollNumber, password } = req.body;
    console.log('Received roll number:', rollNumber);

    try {
        const query = `SELECT * FROM "Student-info" WHERE "rollNumber" = ?`;
        const result = await client.execute(query, [rollNumber]);

        if (result.rows.length === 0) {
            return res.status(404).send({ error: 'Student not found' });
        }

        const student = result.rows[0];
        if (password !== student["parentContact"]) {
            return res.status(401).send({ error: 'Incorrect password' });
        }

        const { password: _, ...studentData } = student;
        res.status(200).json(studentData);
    } catch (error) {
        console.error('Error logging in:', error.message);
        res.status(500).send({ error: 'Internal Server Error' });
    }
});

// Fetch detailed student profile
app.get('/student/:rollNumber', async (req, res) => {
    const rollNumber = req.params.rollNumber;

    try {
        const query = `SELECT * FROM "Student-info" WHERE "rollNumber" = ?`;
        const result = await client.execute(query, [rollNumber]);

        if (result.rows.length === 0) {
            return res.status(404).send({ error: 'Student not found' });
        }

        const student = result.rows[0];
        res.status(200).json(student);
    } catch (error) {
        console.error('Error fetching student details:', error.message);
        res.status(500).send({ error: 'Internal Server Error' });
    }
});

// File Upload Route
app.post('/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send({ error: 'No file uploaded' });
        }
        const uploadedImageUrl = req.file.path;
        console.log('Uploaded Image URL:', uploadedImageUrl);
        res.status(200).send({ secure_url: uploadedImageUrl });
    } catch (error) {
        console.error('Upload Error:', error.message);
        res.status(500).send({ error: 'Internal Server Error' });
    }
});

// Fetch All Uploaded Images Route
app.get('/images', async (req, res) => {
    try {
        const { resources } = await cloudinary.search
            .expression('folder:uploads')
            .sort_by('created_at', 'desc')
            .max_results(30)
            .execute();

        const imageUrls = resources.map((file) => file.secure_url);
        res.status(200).send(imageUrls);
    } catch (error) {
        console.error('Error fetching images:', error.message);
        res.status(500).send({ error: 'Internal Server Error' });
    }
});

// Fetch Marks Report
app.get("/report/:id", async (req, res) => {
  const { id } = req.params;
  console.log("Received roll number:", id);

  if (!id) {
    return res.status(400).json({ message: "Roll number is required" });
  }

  try {
    const query = `
      SELECT 
        si.rollNumber, 
        si.firstName, 
        si.lastName, 
        sm.subject, 
        sm.marks, 
        sm.grade, 
        sm.typeofexam
      FROM "Student-info" si
      JOIN "Student_Marks" sm ON si.rollNumber = sm.rollNumber
      WHERE si.rollNumber = ?
    `;

    console.log("Executing query:", query);
    console.log("With parameters:", [id]);

    // Use the 'client' instance instead of 'db'
    const result = await client.execute(query, [id]);

    console.log("Query Result:", result.rows);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: `No exam reports found for roll number ${id}` });
    }

    res.status(200).json(result.rows);
  } catch (error) {
    console.error(`Error fetching exam report for roll number ${id}:`, error);
    res.status(500).send("Failed to retrieve the exam report");
  }
});

// Route to fetch attendance by roll number across multiple class sheets
app.post("/attendance/rollNumber", async (req, res) => {
  const { rollNumber } = req.body;

  if (!rollNumber) {
    return res.status(400).json({ error: "Missing required field: rollNumber" });
  }

  try {
    let studentAttendanceData = null;

    for (const classSheet of classSheets) {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${classSheet}!A1:Z`,
      });

      const rows = response.data.values || [];
      const headers = rows[0]; // Date headers
      const studentRow = rows.find(row => row[0] === rollNumber);

      if (studentRow) {
        // Construct attendance data with dates
        const attendanceData = headers.slice(4).map((date, index) => ({
          date,
          status: studentRow[4 + index] // Assuming attendance starts from the 5th column
        }));

        studentAttendanceData = {
          classSheet,
          rollNumber: studentRow[0],
          studentName: studentRow[1],
          section: studentRow[3],
          attendance: attendanceData
        };
        break;
      }
    }

    if (!studentAttendanceData) {
      return res.status(404).json({ error: "Student not found in any class sheet." });
    }

    res.json({ success: true, attendanceData: studentAttendanceData });
  } catch (error) {
    console.error("Error fetching attendance report:", error.message);
    res.status(500).json({ error: "Failed to fetch attendance report" });
  }
});

// Route to fetch latest date attendance by roll number
app.post("/attendance/latest", async (req, res) => {
  const { rollNumber } = req.body;

  if (!rollNumber) {
    return res.status(400).json({ error: "Missing required field: rollNumber" });
  }

  try {
    let latestAttendanceData = null;

    for (const classSheet of classSheets) {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${classSheet}!A1:Z`,
      });

      const rows = response.data.values || [];
      const headers = rows[0]; // Date headers
      const studentRow = rows.find(row => row[0] === rollNumber);

      if (studentRow) {
        // Identify the latest date
        const latestDateIndex = headers.length - 1;
        const latestDate = headers[latestDateIndex];
        const latestAttendanceStatus = studentRow[latestDateIndex];

        latestAttendanceData = {
          classSheet,
          rollNumber: studentRow[0],
          studentName: studentRow[1],
          section: studentRow[3],
          latestDate,
          latestAttendanceStatus
        };
        break;
      }
    }

    if (!latestAttendanceData) {
      return res.status(404).json({ error: "Student not found in any class sheet." });
    }

    res.json({ success: true, latestAttendanceData });
  } catch (error) {
    console.error("Error fetching latest attendance report:", error.message);
    res.status(500).json({ error: "Failed to fetch latest attendance report" });
  }
});

//Attendance Tracker
app.post("/attendance/tracker", async (req, res) => {
  const { rollNumber } = req.body;

  if (!rollNumber) {
    return res.status(400).json({ error: "Missing required field: rollNumber" });
  }

  try {
    let totalDays = 0;
    let daysPresent = 0;
    let found = false;

    for (const classSheet of classSheets) {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${classSheet}!A1:Z`,
      });

      const rows = response.data.values || [];
      const headers = rows[0]; // Date headers
      const studentRow = rows.find(row => row[0] === rollNumber);

      if (studentRow) {
        const attendanceData = headers.slice(4).map((date, index) => ({
          date,
          status: studentRow[4 + index] // Assuming attendance starts from the 5th column
        }));

        totalDays = attendanceData.length;
        daysPresent = attendanceData.filter(entry => entry.status === "Present").length;
        found = true;
        break;
      }
    }

    if (!found) {
      return res.status(404).json({ error: "Student not found in any class sheet." });
    }

    const attendancePercentage = (daysPresent / totalDays) * 100;

    res.json({
      success: true,
      totalDays,
      daysPresent,
      attendancePercentage: attendancePercentage.toFixed(2) // Format to two decimal places
    });
  } catch (error) {
    console.error("Error fetching attendance report:", error.message);
    res.status(500).json({ error: "Failed to fetch attendance report" });
  }
});

// Fee Status
// Fetch Fee Status
app.get("/feeStatus/:rollNumber", async (req, res) => {
  const { rollNumber } = req.params;
  console.log("Received roll number:", rollNumber);

  if (!rollNumber) {
    return res.status(400).json({ message: "Roll number is required" });
  }

  try {
    const query = `
      SELECT feeStatus
      FROM "Student-info"
      WHERE rollNumber = ?
    `;

    console.log("Executing query:", query);
    console.log("With parameters:", [rollNumber]);

    // Use the 'client' instance for database operations
    const result = await client.execute(query, [rollNumber]);

    console.log("Query Result:", result.rows);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: `No fee status found for roll number ${rollNumber}` });
    }

    res.status(200).json({ feeStatus: result.rows[0].feeStatus });
  } catch (error) {
    console.error(`Error fetching fee status for roll number ${rollNumber}:`, error);
    res.status(500).send("Failed to retrieve the fee status");
  }
});


// Route to get the list of PDFs for a specific class' general timetable
app.get("/api/timetables/view/:class", (req, res) => {
  const className = req.params.class;
  const folderName = `Class_Timetables/${className}`;

  imagekit.listFiles({
    path: folderName,
    fileType: 'all',
  }, (error, result) => {
    if (error) {
      console.error('Error fetching file list:', error);
      return res.status(500).send(error);
    }

    // Map the result to only include the necessary information
    const pdfFiles = result.map(file => ({
      fileName: file.name,
      url: file.url,
      fileId: file.fileId
    }));

    res.json(pdfFiles);
  });
});


// Route to get the list of PDFs for a specific class' exam timetable
app.get("/api/exam-timetables/view/:class", (req, res) => {
  const className = req.params.class;
  const folderName = `Exam_Timetables/${className}`;

  imagekit.listFiles({
    path: folderName,
    fileType: 'all',
  }, (error, result) => {
    if (error) {
      console.error('Error fetching file list:', error);
      return res.status(500).send({ error: 'Failed to fetch file list' });
    }

    // Map the result to only include the necessary information
    const pdfFiles = result.map(file => ({
      fileName: file.name,
      url: file.url,
      fileId: file.fileId
    }));

    res.json(pdfFiles);
  });
});

// New Route to Fetch Posts from Google Sheets
app.get('/get-posts', async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: DATA_SHEET_ID,
      range: 'Sheet1!A:C', // Adjust the range to A:C
    });

    const rows = response.data.values;
    if (rows && rows.length) {
      const posts = rows.map((row) => ({
        title: row[0],
        description: row[1],
        timestamp: row[2],
      }));

      res.status(200).json(posts);
    } else {
      res.status(200).send('No posts found.');
    }
  } catch (error) {
    res.status(500).send(`Error retrieving posts: ${error}`);
  }
});

// New Route for support email

// Function to send email
async function sendEmail(to, subject, text) {
  if (!to) {
    throw new Error('No recipients defined');
  }

  let transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASSWORD,
    },
  });

  let mailOptions = {
    from: EMAIL_USER,
    to: to,
    subject: subject,
    text: text,
  };

  return transporter.sendMail(mailOptions);
}

// Function to validate email addresses
function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

// Endpoint to handle form submission
app.post('/submit', async (req, res) => {
  const formData = req.body;

  try {
    // Append form data to the spreadsheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!B2', // Adjust the range as needed
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [
          [
            formData.first_name,
            formData.middle_name,
            formData.last_name,
            formData.email,
            formData.department,
            formData.input_radio,
            formData.input_radio_1,
            formData.input_radio_2,
            formData.input_text,
            formData.description,
          ],
        ],
      },
    });

    // Retrieve specific emails from cells A1, A2, and A3
    const emailResponse = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: SHEET_ID,
      ranges: ['Sheet1!A1', 'Sheet1!A2', 'Sheet1!A3'],
    });

    const emailAddresses = emailResponse.data.valueRanges
      .map(range => range.values && range.values[0] ? range.values[0][0] : null)
      .filter(email => email);

    console.log('Retrieved Email Addresses:', emailAddresses); // Debug log to check email addresses

    // Filter out invalid email addresses
    const validEmailAddresses = emailAddresses.filter(isValidEmail);
    console.log('Valid Email Addresses:', validEmailAddresses); // Debug log to check valid email addresses

    // Check if valid email addresses are retrieved
    if (validEmailAddresses.length === 0) {
      throw new Error('No valid email addresses found in specified cells');
    }

    // Send saved form data to each valid email address
    for (const email of validEmailAddresses) {
      console.log('Sending email to:', email); // Debug log to check email sending

      const savedData = `
        First Name: ${formData.first_name}
        Middle Name: ${formData.middle_name}
        Last Name: ${formData.last_name}
        Email: ${formData.email}
        Department: ${formData.department}
        Input Radio: ${formData.input_radio}
        Input Radio 1: ${formData.input_radio_1}
        Input Radio 2: ${formData.input_radio_2}
        Input Text: ${formData.input_text}
        Description: ${formData.description}
      `;
      
      await sendEmail(email, 'Form Submission Data', savedData);
    }

    res.status(200).send('Form data saved and emails sent successfully!');
  } catch (error) {
    console.error('Error saving form data or sending emails:', error);
    res.status(500).send('Error saving form data or sending emails');
  }
});


// Start the Server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});