require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 5000;

// ==================== CONFIGURATION ====================
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL ERROR: JWT_SECRET is not defined.');
  process.exit(1);
}

const DEFAULT_TERM = 1;
const DEFAULT_YEAR = new Date().getFullYear();

// ==================== DATABASE POOL ====================
const isProduction = process.env.NODE_ENV === 'production';

let pool;

try {
  if (process.env.DATABASE_URL) {
    console.log('Using DATABASE_URL for connection');
    console.log(`Connecting to database: ${new URL(process.env.DATABASE_URL).pathname.substring(1)}`);

    const dbUrl = new URL(process.env.DATABASE_URL);

    pool = new Pool({
      user: decodeURIComponent(dbUrl.username),
      password: decodeURIComponent(dbUrl.password),
      host: dbUrl.hostname,
      port: parseInt(dbUrl.port || '5432'),
      database: dbUrl.pathname.substring(1),
      ssl: isProduction ? { rejectUnauthorized: false } : false,
      // Connection pool optimizations
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  } else {
    console.log('Using individual DB parameters for connection');
    pool = new Pool({
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'ophunzira',
      password: process.env.DB_PASSWORD ? String(process.env.DB_PASSWORD) : 'postgres',
      port: parseInt(process.env.DB_PORT || '5432'),
      ssl: isProduction ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  // Test the connection
  pool.connect((err, client, release) => {
    if (err) {
      console.error('❌ Error connecting to database:', err.message);
      console.error('Connection details:');
      console.error(`  - Environment: ${process.env.NODE_ENV || 'development'}`);
      console.error(`  - SSL Enabled: ${isProduction ? 'Yes' : 'No'}`);
      console.error(`  - Database: ${process.env.DB_NAME || 'from DATABASE_URL'}`);

      if (err.message.includes('password must be a string')) {
        console.error('\n💡 PASSWORD ISSUE DETECTED:');
        console.error('   Your password contains special characters that need proper encoding.');
        console.error('   Fix options:');
        console.error('   1. URL-encode your password in DATABASE_URL');
        console.error('   2. Use individual DB_* parameters instead');
        console.error('   3. Simplify your password (remove special chars temporarily)\n');
      }

      if (isProduction) {
        process.exit(1);
      }
    } else {
      console.log('✅ Connected to PostgreSQL database');

      // Log which database we're connected to
      client.query('SELECT current_database()', (err, result) => {
        if (!err) {
          console.log(`📊 Connected to database: ${result.rows[0].current_database}`);
        }
        release();
      });
    }
  });

  // Add pool error handler
  pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err);
  });

} catch (err) {
  console.error('❌ Failed to create database pool:', err.message);
  if (isProduction) {
    process.exit(1);
  }
}

// ==================== DATABASE INITIALIZATION ====================
(async () => {
  try {
    // Check if tables exist and create them if they don't

    // First, check if users table exists (core table)
    const usersTableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'users'
      );
    `);

    if (!usersTableCheck.rows[0].exists) {
      console.log('Creating users table...');
      await pool.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(100) UNIQUE NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          role VARCHAR(50) NOT NULL DEFAULT 'teacher',
          class_id INTEGER,
          phone VARCHAR(20),
          address TEXT,
          department VARCHAR(100),
          specialization VARCHAR(100),
          profile_pic_url TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
      console.log('✅ Users table created');
    }

    // Check if learners table exists
    const learnersTableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'learners'
      );
    `);

    if (!learnersTableCheck.rows[0].exists) {
      console.log('Creating learners table...');
      await pool.query(`
        CREATE TABLE learners (
          id SERIAL PRIMARY KEY,
          username VARCHAR(100) NOT NULL,
          reg_number VARCHAR(50) UNIQUE NOT NULL,
          class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
      console.log('✅ Learners table created');
    }

    // Check if classes table exists
    const classesTableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'classes'
      );
    `);

    if (!classesTableCheck.rows[0].exists) {
      console.log('Creating classes table...');
      await pool.query(`
        CREATE TABLE classes (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          year INTEGER NOT NULL,
          teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
      console.log('✅ Classes table created');
    }

    // Audit logs table
    const auditLogsCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'audit_logs'
      );
    `);

    if (!auditLogsCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE audit_logs (
          id SERIAL PRIMARY KEY,
          user_id INT REFERENCES users(id) ON DELETE SET NULL,
          action VARCHAR(255) NOT NULL,
          details TEXT,
          ip_address INET,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
      console.log('✅ Audit logs table created');
    }

    // Term settings table
    const termSettingsCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'term_settings'
      );
    `);

    if (!termSettingsCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE term_settings (
          id SERIAL PRIMARY KEY,
          class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
          term INTEGER NOT NULL,
          year INTEGER NOT NULL,
          total_days INTEGER NOT NULL DEFAULT 30,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(class_id, term, year)
        );
      `);
      console.log('✅ Term settings table created');
    }

    // Announcements table
    const announcementsCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'announcements'
      );
    `);

    if (!announcementsCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE announcements (
          id SERIAL PRIMARY KEY,
          teacher_id INT REFERENCES users(id) ON DELETE SET NULL,
          title VARCHAR(255) NOT NULL,
          content TEXT NOT NULL,
          target_class_id INT REFERENCES classes(id) ON DELETE CASCADE,
          target_all BOOLEAN DEFAULT false,
          priority VARCHAR(20) DEFAULT 'normal',
          expires_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
      console.log('✅ Announcements table created');
    }

    // Subject templates table
    const subjectTemplatesCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'subject_templates'
      );
    `);

    if (!subjectTemplatesCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE subject_templates (
          id SERIAL PRIMARY KEY,
          class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
          subject_name VARCHAR(100) NOT NULL,
          total_marks INTEGER NOT NULL DEFAULT 100,
          display_order INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
      console.log('✅ Subject templates table created');
    }

    // Attendance table
    const attendanceCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'attendance'
      );
    `);

    if (!attendanceCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE attendance (
          id SERIAL PRIMARY KEY,
          learner_id INTEGER REFERENCES learners(id) ON DELETE CASCADE,
          date DATE NOT NULL,
          status VARCHAR(20) NOT NULL,
          teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          attendance_date DATE,
          term INTEGER DEFAULT 1,
          year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE),
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(learner_id, date)
        );
      `);
      console.log('✅ Attendance table created');
    }

    // Subject results table
    const subjectResultsCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'subject_results'
      );
    `);

    if (!subjectResultsCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE subject_results (
          id SERIAL PRIMARY KEY,
          learner_id INTEGER REFERENCES learners(id) ON DELETE CASCADE,
          template_id INTEGER REFERENCES subject_templates(id) ON DELETE CASCADE,
          term INTEGER NOT NULL,
          year INTEGER NOT NULL,
          test1_score INTEGER DEFAULT 0,
          test2_score INTEGER DEFAULT 0,
          exam_score INTEGER DEFAULT 0,
          marks_scored INTEGER DEFAULT 0,
          grade VARCHAR(5),
          remarks TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(learner_id, template_id, term, year)
        );
      `);
      console.log('✅ Subject results table created');
    }

    // Report cards table
    const reportCardsCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'report_cards'
      );
    `);

    if (!reportCardsCheck.rows[0].exists) {
      await pool.query(`
        CREATE TABLE report_cards (
          id SERIAL PRIMARY KEY,
          learner_id INTEGER REFERENCES learners(id) ON DELETE CASCADE,
          term INTEGER NOT NULL,
          year INTEGER NOT NULL,
          attendance_days INTEGER DEFAULT 0,
          teacher_comment TEXT,
          conduct VARCHAR(50),
          position INTEGER,
          pass_fail_status VARCHAR(20) DEFAULT 'PENDING',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(learner_id, term, year)
        );
      `);
      console.log('✅ Report cards table created');
    }

    // Check for updated_at column in users table
    const columnCheck = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'updated_at'
    `);

    if (columnCheck.rows.length === 0) {
      await pool.query(`
        ALTER TABLE users
        ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      `);
      console.log('✅ Added updated_at column to users table');
    }

    console.log('✅ All database tables are ready');

    // Log table count
    const tablesCount = await pool.query(`
      SELECT COUNT(*) as count
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    console.log(`📊 Total tables in database: ${tablesCount.rows[0].count}`);

  } catch (err) {
    console.error('Error setting up database:', err);
  }
})();

// ==================== MIDDLEWARE ====================
const allowedOrigins = [
  'https://sukulu.netlify.app',
  'http://localhost:5000',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:5000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1 && origin !== 'null') {
      console.log('Blocked origin:', origin);
      return callback(null, false);
    }
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true,
  optionsSuccessStatus: 200
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// ==================== AUTHENTICATION MIDDLEWARE ====================
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Access denied' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid token' });
    req.user = user;
    next();
  });
};

const authenticateAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Admin only.'
    });
  }
  next();
};

// ==================== GRADE CALCULATION FUNCTIONS ====================
const calculateAverage = (test1, test2, exam) => {
  return (test1 + test2 + exam) / 3;
};

const calculateGradeFromAverage = (average, totalMarks) => {
  if (totalMarks <= 0) return 'N/A';
  const percentage = (average / totalMarks) * 100;
  if (percentage >= 85) return 'A';
  if (percentage >= 75) return 'B';
  if (percentage >= 65) return 'C';
  if (percentage >= 40) return 'D';
  return 'F';
};

const calculateRemarksFromAverage = (average, totalMarks) => {
  if (totalMarks <= 0) return 'N/A';
  const percentage = (average / totalMarks) * 100;
  if (percentage >= 85) return 'Excellent';
  if (percentage >= 75) return 'Very Good';
  if (percentage >= 65) return 'Good';
  if (percentage >= 40) return 'Average';
  return 'Fail';
};

// ==================== HELPER FUNCTIONS ====================
const logAdminAction = async (userId, action, details, ip) => {
  try {
    await pool.query(
      'INSERT INTO audit_logs (user_id, action, details, ip_address) VALUES ($1, $2, $3, $4)',
      [userId, action, details, ip]
    );
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
};

// ==================== HEALTH CHECK ENDPOINTS ====================
app.get('/', (req, res) => {
  res.json({
    name: 'Ophunzira API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      apiHealth: '/api/health',
      test: '/api/test',
      testConnection: '/api/test-connection'
    },
    documentation: 'See /api/health for all available endpoints'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    database: process.env.DATABASE_URL ? 'configured' : 'not configured'
  });
});

app.get('/api/health', async (req, res) => {
  let dbStatus = 'disconnected';
  let dbName = 'unknown';

  try {
    const result = await pool.query('SELECT current_database()');
    dbStatus = 'connected';
    dbName = result.rows[0].current_database;
  } catch (err) {
    console.error('Health check database error:', err.message);
  }

  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    database: dbStatus,
    database_name: dbName,
    environment: {
      node_version: process.version,
      platform: process.platform,
      production: isProduction
    },
    endpoints: {
      auth: ['/login', '/api/login', '/leaner-login', '/verify'],
      profile: ['/teacher/profile', '/teacher/upload-profile-pic', '/teacher/change-password'],
      classes: ['/api/classes'],
      learners: ['/api/teacher/learners/:classId'],
      subjects: ['/api/teacher/subjects/:classId'],
      attendance: [
        '/api/attendance/count/:learnerId',
        '/api/learner/attendance-stats',
        '/api/learner/attendance/today',
        '/api/teacher/attendance/project',
        '/api/attendance/summary/:classId',
        '/api/learner/attendance-summary'
      ],
      reports: ['/api/teacher/report-card/:learnerId', '/api/learner/my-report'],
      termSettings: ['/api/term-settings (GET)', '/api/term-settings (POST)'],
      announcements: [
        '/api/teacher/announcements (POST)',
        '/api/teacher/announcements (GET)',
        '/api/teacher/announcements/:id (DELETE)',
        '/api/learner/announcements (GET)'
      ],
      admin: [
        '/api/admin/stats',
        '/api/admin/teachers',
        '/api/admin/classes',
        '/api/admin/subjects/:classId',
        '/api/admin/learners',
        '/api/admin/audit-logs'
      ],
      test: ['/api/test-connection']
    }
  });
});

// Test endpoints
app.get('/api/test', (req, res) => {
  res.json({
    message: 'API is working',
    timestamp: new Date().toISOString()
  });
});

// ==================== TEST CONNECTION ENDPOINT ====================
app.get('/api/test-connection', async (req, res) => {
  try {
    // Test basic connection
    const dbResult = await pool.query('SELECT current_database() as db_name');
    const currentDb = dbResult.rows[0].db_name;

    // Test if we can create a test table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS connection_test (
        id SERIAL PRIMARY KEY,
        test_message VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Insert a test record
    await pool.query(
      'INSERT INTO connection_test (test_message) VALUES ($1)',
      ['Connection test at ' + new Date().toISOString()]
    );

    // Retrieve the test records
    const testResults = await pool.query(
      'SELECT * FROM connection_test ORDER BY created_at DESC LIMIT 5'
    );

    // Get list of all tables
    const tablesResult = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    res.json({
      success: true,
      message: 'Database connection is working!',
      database: {
        current_database: currentDb,
        connection_status: 'connected',
        environment: process.env.NODE_ENV || 'development'
      },
      tables: {
        count: tablesResult.rows.length,
        list: tablesResult.rows.map(row => row.table_name)
      },
      test_data: testResults.rows,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('Test connection error:', err);
    res.status(500).json({
      success: false,
      message: 'Database connection test failed',
      error: err.message,
      hint: 'Check your DATABASE_URL environment variable and ensure the database exists'
    });
  }
});

// ==================== AUTHENTICATION ROUTES ====================
app.post('/api/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password required' });
    }

    const result = await pool.query(
      `SELECT id, username, email, password_hash, role, class_id,
              phone, address, department, specialization, profile_pic_url,
              created_at
       FROM users
       WHERE email = $1`,
      [email]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        class_id: user.class_id,
        phone: user.phone || '',
        address: user.address || '',
        department: user.department || '',
        specialization: user.specialization || '',
        profile_pic_url: user.profile_pic_url || '',
        created_at: user.created_at,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    next(err);
  }
});

app.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password required' });
    }

    const result = await pool.query(
      `SELECT id, username, email, password_hash, role, class_id,
              phone, address, department, specialization, profile_pic_url,
              created_at
       FROM users
       WHERE email = $1`,
      [email]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        class_id: user.class_id,
        phone: user.phone || '',
        address: user.address || '',
        department: user.department || '',
        specialization: user.specialization || '',
        profile_pic_url: user.profile_pic_url || '',
        created_at: user.created_at,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    next(err);
  }
});

app.post('/leaner-login', async (req, res, next) => {
  try {
    const { username, registrationNumber } = req.body;

    if (!username || !registrationNumber) {
      return res.status(400).json({ message: 'Username and registration number required' });
    }

    const result = await pool.query(
      `SELECT l.*, c.name as class_name
       FROM learners l
       LEFT JOIN classes c ON l.class_id = c.id
       WHERE LOWER(l.username) = LOWER($1) AND l.reg_number = $2`,
      [username, registrationNumber]
    );
    const learner = result.rows[0];

    if (!learner) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: learner.id, role: 'learner', username: learner.username, regNumber: learner.reg_number },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: learner.id,
        username: learner.username,
        role: 'learner',
        class_id: learner.class_id,
        regNumber: learner.reg_number,
        class_name: learner.class_name,
      },
    });
  } catch (err) {
    next(err);
  }
});

app.post('/verify', authenticateToken, (req, res) => {
  res.json({
    user: req.user,
    message: 'Token is valid'
  });
});

// ==================== TEACHER PROFILE ENDPOINTS ====================
app.get('/teacher/profile', authenticateToken, async (req, res, next) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Teacher only.'
      });
    }

    const userId = req.user.userId;

    const userResult = await pool.query(
      `SELECT u.id, u.username, u.email, u.phone, u.address,
              u.department, u.specialization, u.profile_pic_url,
              u.created_at
       FROM users u
       WHERE u.id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Teacher not found'
      });
    }

    res.json({
      success: true,
      data: userResult.rows[0]
    });
  } catch (err) {
    console.error('Error fetching teacher profile:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

app.put('/teacher/profile', authenticateToken, async (req, res, next) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Teacher only.'
      });
    }

    const userId = req.user.userId;
    const { username, email, phone, address, department, specialization } = req.body;

    if (!username || !email) {
      return res.status(400).json({
        success: false,
        message: 'Username and email are required'
      });
    }

    const emailCheck = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND id != $2',
      [email, userId]
    );

    if (emailCheck.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Email already in use by another account'
      });
    }

    const result = await pool.query(
      `UPDATE users
       SET username = $1,
           email = $2,
           phone = $3,
           address = $4,
           department = $5,
           specialization = $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING id, username, email, phone, address, department, specialization, profile_pic_url`,
      [username, email, phone, address, department, specialization, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    await logAdminAction(userId, 'UPDATE_PROFILE', 'Updated teacher profile', req.ip);

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: result.rows[0]
    });
  } catch (err) {
    console.error('Error updating teacher profile:', err);

    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Email already exists',
        error: err.message
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to update profile',
      error: err.message
    });
  }
});

app.post('/teacher/upload-profile-pic', authenticateToken, async (req, res, next) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Teacher only.'
      });
    }

    const userId = req.user.userId;
    const { profile_pic_url } = req.body;

    if (!profile_pic_url) {
      return res.status(400).json({
        success: false,
        message: 'No image data provided.'
      });
    }

    await pool.query(
      'UPDATE users SET profile_pic_url = $1 WHERE id = $2',
      [profile_pic_url, userId]
    );

    res.json({
      success: true,
      message: 'Profile picture updated successfully',
      profile_pic_url: profile_pic_url
    });
  } catch (err) {
    console.error('Error uploading profile picture:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to upload profile picture',
      error: err.message
    });
  }
});

app.put('/teacher/change-password', authenticateToken, async (req, res, next) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Teacher only.'
      });
    }

    const userId = req.user.userId;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password required'
      });
    }

    const userResult = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const validPassword = await bcrypt.compare(
      currentPassword,
      userResult.rows[0].password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [hashedPassword, userId]
    );

    await logAdminAction(userId, 'CHANGE_PASSWORD', 'Changed password', req.ip);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (err) {
    console.error('Error changing password:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to change password',
      error: err.message
    });
  }
});

// ==================== API V1 ROUTES ====================

// TERM SETTINGS ENDPOINTS
app.get('/api/term-settings', authenticateToken, async (req, res) => {
  try {
    const { class_id, term, year } = req.query;

    if (!class_id || !term || !year) {
      return res.status(400).json({
        success: false,
        message: 'class_id, term, and year are required'
      });
    }

    const result = await pool.query(
      `SELECT * FROM term_settings
       WHERE class_id = $1 AND term = $2 AND year = $3`,
      [class_id, term, year]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Term settings not found'
      });
    }

    res.json({
      success: true,
      ...result.rows[0]
    });
  } catch (err) {
    console.error('Error fetching term settings:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

app.post('/api/term-settings', authenticateToken, async (req, res) => {
  try {
    const { class_id, term, year, total_days } = req.body;

    if (!class_id || !term || !year || !total_days) {
      return res.status(400).json({
        success: false,
        message: 'class_id, term, year, and total_days are required'
      });
    }

    const existing = await pool.query(
      `SELECT id FROM term_settings
       WHERE class_id = $1 AND term = $2 AND year = $3`,
      [class_id, term, year]
    );

    let result;
    if (existing.rows.length > 0) {
      result = await pool.query(
        `UPDATE term_settings
         SET total_days = $1, updated_at = CURRENT_TIMESTAMP
         WHERE class_id = $2 AND term = $3 AND year = $4
         RETURNING *`,
        [total_days, class_id, term, year]
      );
    } else {
      result = await pool.query(
        `INSERT INTO term_settings (class_id, term, year, total_days)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [class_id, term, year, total_days]
      );
    }

    await logAdminAction(
      req.user.userId,
      'UPDATE_TERM_SETTINGS',
      `Updated term settings for class ${class_id}: ${total_days} days`,
      req.ip
    );

    res.json({
      success: true,
      message: 'Term settings saved successfully',
      data: result.rows[0]
    });
  } catch (err) {
    console.error('Error saving term settings:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// ATTENDANCE ENDPOINTS
app.get('/api/attendance/count/:learnerId', authenticateToken, async (req, res, next) => {
  try {
    const { learnerId } = req.params;
    const { term, year } = req.query;

    const attendance = await pool.query(
      `SELECT COUNT(*) as count
       FROM attendance
       WHERE learner_id = $1
       AND term = $2
       AND year = $3
       AND status = 'present'`,
      [learnerId, term || DEFAULT_TERM, year || DEFAULT_YEAR]
    );

    res.json({
      attendance_days: parseInt(attendance.rows[0].count),
      count: parseInt(attendance.rows[0].count)
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/learner/attendance-stats', authenticateToken, async (req, res, next) => {
  try {
    const learnerId = req.user.userId;
    const { term = DEFAULT_TERM, year = DEFAULT_YEAR } = req.query;

    console.log(`Fetching attendance stats for learner ${learnerId}, term ${term}, year ${year}`);

    const result = await pool.query(
      `SELECT
         COUNT(*) as total_days,
         COUNT(*) FILTER (WHERE status = 'present') as present_days,
         COUNT(*) FILTER (WHERE status = 'absent') as absent_days
       FROM attendance
       WHERE learner_id = $1 AND term = $2 AND year = $3`,
      [learnerId, term, year]
    );

    const { total_days, present_days, absent_days } = result.rows[0];
    const totalDaysInt = parseInt(total_days) || 0;
    const presentDaysInt = parseInt(present_days) || 0;
    const percentage = totalDaysInt > 0 ? Math.round((presentDaysInt / totalDaysInt) * 100) : 0;

    res.json({
      percentage,
      present: presentDaysInt,
      absences: parseInt(absent_days) || 0,
      total: totalDaysInt
    });
  } catch (err) {
    console.error('Error fetching attendance stats:', err);
    next(err);
  }
});

app.get('/api/learner/attendance/today', authenticateToken, async (req, res, next) => {
  try {
    const learnerId = req.user.userId;
    const today = new Date().toISOString().split('T')[0];

    const result = await pool.query(
      `SELECT a.status, u.username as teacher_name, a.date
       FROM attendance a
       LEFT JOIN users u ON a.teacher_id = u.id
       WHERE a.learner_id = $1 AND a.date = $2`,
      [learnerId, today]
    );

    if (result.rows.length > 0) {
      res.json({
        status: result.rows[0].status,
        teacher_name: result.rows[0].teacher_name || 'Unknown',
        date: result.rows[0].date
      });
    } else {
      res.json({
        status: 'Not Marked',
        teacher_name: null,
        date: today
      });
    }
  } catch (err) {
    console.error('Error fetching today attendance:', err);
    next(err);
  }
});

app.post('/api/teacher/attendance/project', authenticateToken, async (req, res, next) => {
  const { date, records, term = DEFAULT_TERM, year = DEFAULT_YEAR } = req.body;
  const teacherId = req.user.userId;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    console.log(`Saving attendance for date: ${date}, term: ${term}, year: ${year}`);

    for (const record of records) {
      const status = record.isPresent ? 'present' : 'absent';
      await client.query(
        `INSERT INTO attendance (learner_id, date, status, teacher_id, attendance_date, term, year)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (learner_id, date)
         DO UPDATE SET status = EXCLUDED.status, teacher_id = EXCLUDED.teacher_id, term = EXCLUDED.term, year = EXCLUDED.year`,
        [record.learnerId, date, status, teacherId, date, term, year]
      );
    }
    await client.query('COMMIT');
    res.status(200).json({ message: 'Attendance saved successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error saving attendance:', error);
    next(error);
  } finally {
    client.release();
  }
});

app.get('/api/attendance/summary/:classId', authenticateToken, async (req, res) => {
  try {
    const { classId } = req.params;
    const { term = DEFAULT_TERM, year = DEFAULT_YEAR } = req.query;

    const termSettings = await pool.query(
      `SELECT total_days FROM term_settings
       WHERE class_id = $1 AND term = $2 AND year = $3`,
      [classId, term, year]
    );

    const totalDays = termSettings.rows.length > 0
      ? termSettings.rows[0].total_days
      : 30;

    const result = await pool.query(
      `SELECT
         l.id,
         l.username,
         l.reg_number,
         COUNT(CASE WHEN a.status = 'present' THEN 1 END) as present_count
       FROM learners l
       LEFT JOIN attendance a ON l.id = a.learner_id
         AND a.term = $1 AND a.year = $2
       WHERE l.class_id = $3
       GROUP BY l.id, l.username, l.reg_number
       ORDER BY l.username ASC`,
      [term, year, classId]
    );

    const summary = result.rows.map(row => ({
      id: row.id,
      username: row.username,
      reg_number: row.reg_number,
      present: parseInt(row.present_count) || 0,
      absent: totalDays - (parseInt(row.present_count) || 0),
      total: totalDays
    }));

    res.json({
      success: true,
      total_days: totalDays,
      learners: summary
    });
  } catch (err) {
    console.error('Error fetching attendance summary:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// CLASSES ENDPOINTS
app.get('/api/classes', authenticateToken, async (req, res, next) => {
  try {
    let query;
    let params = [];

    if (req.user.role === 'admin') {
      query = `
        SELECT c.*,
               COUNT(l.id) as learner_count,
               u.username as teacher_name
        FROM classes c
        LEFT JOIN learners l ON c.id = l.class_id
        LEFT JOIN users u ON c.teacher_id = u.id
        GROUP BY c.id, u.username
        ORDER BY c.year DESC, c.name ASC
      `;
    } else {
      query = `
        SELECT c.*,
               COUNT(l.id) as learner_count
        FROM classes c
        LEFT JOIN learners l ON c.id = l.class_id
        WHERE c.teacher_id = $1
        GROUP BY c.id
        ORDER BY c.year DESC, c.name ASC
      `;
      params = [req.user.userId];
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error in /api/classes endpoint:', err);
    next(err);
  }
});

// LEARNERS ENDPOINTS
app.get('/api/teacher/learners/:classId', authenticateToken, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT l.id, l.username, l.reg_number
       FROM learners l
       WHERE l.class_id = $1
       ORDER BY l.username ASC`,
      [req.params.classId]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// SUBJECTS ENDPOINTS
app.get('/api/teacher/subjects/:classId', authenticateToken, async (req, res, next) => {
  if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const { classId } = req.params;
  try {
    if (req.user.role === 'teacher') {
      const classCheck = await pool.query(
        'SELECT id FROM classes WHERE id = $1 AND teacher_id = $2',
        [classId, req.user.userId]
      );
      if (classCheck.rows.length === 0) {
        return res.status(403).json({ message: 'You do not have access to this class' });
      }
    }

    const result = await pool.query(
      `SELECT st.id,
              st.subject_name as name,
              st.total_marks,
              st.display_order
       FROM subject_templates st
       WHERE st.class_id = $1
       ORDER BY st.display_order ASC, st.subject_name ASC`,
      [classId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error in subjects endpoint:', err);
    next(err);
  }
});

// TEACHER REPORT CARDS ENDPOINTS
app.get('/api/teacher/report-card/:learnerId', authenticateToken, async (req, res, next) => {
  const { learnerId } = req.params;
  const { term = DEFAULT_TERM, year = DEFAULT_YEAR } = req.query;

  try {
    const header = await pool.query(
      'SELECT * FROM report_cards WHERE learner_id = $1 AND term = $2 AND year = $3',
      [learnerId, term, year]
    );

    const learner = await pool.query('SELECT class_id FROM learners WHERE id = $1', [learnerId]);
    if (learner.rows.length === 0) {
      return res.status(404).json({ message: 'Learner not found' });
    }

    const subjects = await pool.query(
      `SELECT st.id as template_id,
              st.subject_name as subject_name,
              st.total_marks,
              COALESCE(sr.test1_score, 0) as test1_score,
              COALESCE(sr.test2_score, 0) as test2_score,
              COALESCE(sr.exam_score, 0) as exam_score,
              COALESCE(sr.marks_scored, 0) as marks_scored,
              COALESCE(sr.grade, 'N/A') as grade,
              sr.remarks,
              st.display_order
       FROM subject_templates st
       LEFT JOIN subject_results sr ON st.id = sr.template_id
           AND sr.learner_id = $1 AND sr.term = $2 AND sr.year = $3
       WHERE st.class_id = $4
       ORDER BY st.display_order ASC, st.subject_name ASC`,
      [learnerId, term, year, learner.rows[0].class_id]
    );

    if (header.rows.length === 0) {
      return res.json({
        header: {
          learner_id: parseInt(learnerId),
          term: parseInt(term),
          year: parseInt(year),
          attendance_days: 0,
          teacher_comment: '',
          conduct: '',
          position: null,
          pass_fail_status: 'PENDING'
        },
        subjects: subjects.rows
      });
    }

    res.json({
      header: header.rows[0],
      subjects: subjects.rows
    });
  } catch (err) {
    console.error('Error fetching report card:', err);
    next(err);
  }
});

app.put('/api/teacher/report-card/:learnerId', authenticateToken, async (req, res, next) => {
  const { learnerId } = req.params;
  const { term = DEFAULT_TERM, year = DEFAULT_YEAR } = req.query;
  const { header, subjects } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO report_cards (learner_id, term, year, attendance_days, teacher_comment, conduct, position, pass_fail_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (learner_id, term, year)
       DO UPDATE SET
         attendance_days = EXCLUDED.attendance_days,
         teacher_comment = EXCLUDED.teacher_comment,
         conduct = EXCLUDED.conduct,
         position = EXCLUDED.position,
         pass_fail_status = EXCLUDED.pass_fail_status`,
      [
        learnerId,
        term,
        year,
        header.attendance_days || 0,
        header.teacher_comment || '',
        header.conduct || '',
        header.position || null,
        header.pass_fail_status || 'PENDING'
      ]
    );

    for (const subject of subjects) {
      const average = calculateAverage(
        subject.test1_score || 0,
        subject.test2_score || 0,
        subject.exam_score || 0
      );

      const gradeFromAverage = calculateGradeFromAverage(average, subject.total_marks);
      const remarksFromAverage = calculateRemarksFromAverage(average, subject.total_marks);
      const marksScored = (subject.test1_score || 0) + (subject.test2_score || 0) + (subject.exam_score || 0);

      console.log(`Subject ${subject.template_id}:`);
      console.log(`  Scores: Test1=${subject.test1_score}, Test2=${subject.test2_score}, Exam=${subject.exam_score}`);
      console.log(`  Average: ${average.toFixed(1)}`);
      console.log(`  Grade: ${gradeFromAverage}`);
      console.log(`  Remarks: ${remarksFromAverage}`);

      await client.query(
        `INSERT INTO subject_results (learner_id, template_id, term, year, test1_score, test2_score, exam_score, marks_scored, grade, remarks)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (learner_id, template_id, term, year)
         DO UPDATE SET
           test1_score = EXCLUDED.test1_score,
           test2_score = EXCLUDED.test2_score,
           exam_score = EXCLUDED.exam_score,
           marks_scored = EXCLUDED.marks_scored,
           grade = EXCLUDED.grade,
           remarks = EXCLUDED.remarks`,
        [
          learnerId,
          subject.template_id,
          term,
          year,
          subject.test1_score || 0,
          subject.test2_score || 0,
          subject.exam_score || 0,
          marksScored,
          gradeFromAverage,
          remarksFromAverage
        ]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Report card saved successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error saving report card:', err);
    res.status(500).json({ message: 'Failed to save report card', error: err.message });
  } finally {
    client.release();
  }
});

// LEARNER REPORT CARD ENDPOINTS
app.get('/api/learner/my-report', authenticateToken, async (req, res, next) => {
  try {
    if (req.user.role !== 'learner') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Learner only.'
      });
    }

    const learnerId = req.user.userId;
    const { term = DEFAULT_TERM, year = DEFAULT_YEAR } = req.query;

    const learnerResult = await pool.query(
      `SELECT l.*, c.name as class_name
       FROM learners l
       LEFT JOIN classes c ON l.class_id = c.id
       WHERE l.id = $1`,
      [learnerId]
    );

    if (learnerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Learner not found'
      });
    }

    const learner = learnerResult.rows[0];

    const headerResult = await pool.query(
      `SELECT * FROM report_cards
       WHERE learner_id = $1 AND term = $2 AND year = $3`,
      [learnerId, term, year]
    );

    const subjectsResult = await pool.query(
      `SELECT st.id as template_id,
              st.subject_name as subject_name,
              st.total_marks,
              COALESCE(sr.test1_score, 0) as test1_score,
              COALESCE(sr.test2_score, 0) as test2_score,
              COALESCE(sr.exam_score, 0) as exam_score,
              COALESCE(sr.marks_scored, 0) as marks_scored,
              COALESCE(sr.grade, 'N/A') as grade,
              sr.remarks,
              st.display_order
       FROM subject_templates st
       LEFT JOIN subject_results sr ON st.id = sr.template_id
           AND sr.learner_id = $1 AND sr.term = $2 AND sr.year = $3
       WHERE st.class_id = $4
       ORDER BY st.display_order ASC, st.subject_name ASC`,
      [learnerId, term, year, learner.class_id]
    );

    let totalScored = 0;
    let totalPossible = 0;
    subjectsResult.rows.forEach(subject => {
      totalScored += subject.marks_scored || 0;
      totalPossible += subject.total_marks || 100;
    });

    const percentage = totalPossible > 0
      ? Math.round((totalScored / totalPossible) * 100)
      : 0;

    const attendanceResult = await pool.query(
      `SELECT COUNT(*) as total_days,
              COUNT(*) FILTER (WHERE status = 'present') as present_days
       FROM attendance
       WHERE learner_id = $1 AND term = $2 AND year = $3`,
      [learnerId, term, year]
    );

    const attendance = attendanceResult.rows[0];
    const attendancePercentage = attendance.total_days > 0
      ? Math.round((attendance.present_days / attendance.total_days) * 100)
      : 0;

    if (headerResult.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          learner: {
            id: learner.id,
            name: learner.username,
            reg_number: learner.reg_number,
            class_name: learner.class_name,
            class_id: learner.class_id
          },
          header: {
            term: parseInt(term),
            year: parseInt(year),
            attendance_days: parseInt(attendance.present_days) || 0,
            total_days: parseInt(attendance.total_days) || 0,
            attendance_percentage: attendancePercentage,
            teacher_comment: '',
            conduct: '',
            position: null,
            pass_fail_status: 'PENDING',
            total_scored: totalScored,
            total_possible: totalPossible,
            percentage: percentage
          },
          subjects: subjectsResult.rows
        }
      });
    }

    const header = headerResult.rows[0];

    res.json({
      success: true,
      data: {
        learner: {
          id: learner.id,
          name: learner.username,
          reg_number: learner.reg_number,
          class_name: learner.class_name,
          class_id: learner.class_id
        },
        header: {
          term: parseInt(term),
          year: parseInt(year),
          attendance_days: parseInt(header.attendance_days) || 0,
          total_days: parseInt(attendance.total_days) || 0,
          attendance_percentage: attendancePercentage,
          teacher_comment: header.teacher_comment || '',
          conduct: header.conduct || '',
          position: header.position,
          pass_fail_status: header.pass_fail_status || 'PENDING',
          total_scored: totalScored,
          total_possible: totalPossible,
          percentage: percentage
        },
        subjects: subjectsResult.rows
      }
    });

  } catch (err) {
    console.error('Error fetching learner report card:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

app.get('/api/learner/attendance-summary', authenticateToken, async (req, res, next) => {
  try {
    if (req.user.role !== 'learner') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Learner only.'
      });
    }

    const learnerId = req.user.userId;
    const { term = DEFAULT_TERM, year = DEFAULT_YEAR } = req.query;

    const attendanceResult = await pool.query(
      `SELECT
         COUNT(*) as total_days,
         COUNT(*) FILTER (WHERE status = 'present') as present_days,
         COUNT(*) FILTER (WHERE status = 'absent') as absent_days
       FROM attendance
       WHERE learner_id = $1 AND term = $2 AND year = $3`,
      [learnerId, term, year]
    );

    const stats = attendanceResult.rows[0];
    const totalDays = parseInt(stats.total_days) || 0;
    const presentDays = parseInt(stats.present_days) || 0;
    const percentage = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;

    const recentResult = await pool.query(
      `SELECT date, status
       FROM attendance
       WHERE learner_id = $1 AND term = $2 AND year = $3
       ORDER BY date DESC
       LIMIT 10`,
      [learnerId, term, year]
    );

    res.json({
      success: true,
      data: {
        summary: {
          total_days: totalDays,
          present_days: presentDays,
          absent_days: parseInt(stats.absent_days) || 0,
          percentage: percentage
        },
        recent: recentResult.rows
      }
    });

  } catch (err) {
    console.error('Error fetching learner attendance:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// ==================== ANNOUNCEMENTS ENDPOINTS ====================

// Create announcement (teacher only)
app.post('/api/teacher/announcements', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Teachers only.'
      });
    }

    const { title, content, class_id, target_all, priority, expires_at } = req.body;

    if (!title || !content) {
      return res.status(400).json({
        success: false,
        message: 'Title and content are required'
      });
    }

    const result = await pool.query(
      `INSERT INTO announcements
       (teacher_id, title, content, target_class_id, target_all, priority, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.userId, title, content, class_id, target_all || false, priority || 'normal', expires_at]
    );

    await logAdminAction(
      req.user.userId,
      'CREATE_ANNOUNCEMENT',
      `Created announcement: ${title}`,
      req.ip
    );

    res.json({
      success: true,
      message: 'Announcement created successfully',
      announcement: result.rows[0]
    });

  } catch (err) {
    console.error('Error creating announcement:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Get teacher's announcements
app.get('/api/teacher/announcements', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Teachers only.'
      });
    }

    const result = await pool.query(
      `SELECT a.*,
              c.name as class_name,
              u.username as teacher_name
       FROM announcements a
       LEFT JOIN classes c ON a.target_class_id = c.id
       LEFT JOIN users u ON a.teacher_id = u.id
       WHERE a.teacher_id = $1
       ORDER BY a.created_at DESC`,
      [req.user.userId]
    );

    res.json({
      success: true,
      announcements: result.rows
    });

  } catch (err) {
    console.error('Error fetching announcements:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Delete announcement
app.delete('/api/teacher/announcements/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Teachers only.'
      });
    }

    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM announcements WHERE id = $1 AND teacher_id = $2 RETURNING *',
      [id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Announcement not found'
      });
    }

    await logAdminAction(
      req.user.userId,
      'DELETE_ANNOUNCEMENT',
      `Deleted announcement ID ${id}`,
      req.ip
    );

    res.json({
      success: true,
      message: 'Announcement deleted successfully'
    });

  } catch (err) {
    console.error('Error deleting announcement:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Get announcements for learner dashboard
app.get('/api/learner/announcements', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'learner') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Learners only.'
      });
    }

    const learnerId = req.user.userId;

    // Get learner's class
    const learnerResult = await pool.query(
      'SELECT class_id FROM learners WHERE id = $1',
      [learnerId]
    );

    if (learnerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Learner not found'
      });
    }

    const classId = learnerResult.rows[0].class_id;

    // Get announcements for this class or all classes
    const result = await pool.query(
      `SELECT a.*, u.username as teacher_name
       FROM announcements a
       LEFT JOIN users u ON a.teacher_id = u.id
       WHERE (a.target_class_id = $1 OR a.target_all = true)
         AND (a.expires_at IS NULL OR a.expires_at > NOW())
       ORDER BY
         CASE a.priority
           WHEN 'high' THEN 1
           WHEN 'normal' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         a.created_at DESC`,
      [classId]
    );

    res.json({
      success: true,
      announcements: result.rows
    });

  } catch (err) {
    console.error('Error fetching learner announcements:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// ==================== LEGACY ROUTES ====================
app.get('/attendance/count/:learnerId', authenticateToken, (req, res) => {
  const { learnerId } = req.params;
  const { term, year } = req.query;
  const queryString = new URLSearchParams({ term, year }).toString();
  res.redirect(307, `/api/attendance/count/${learnerId}${queryString ? '?' + queryString : ''}`);
});

app.get('/classes', authenticateToken, (req, res) => {
  res.redirect(307, '/api/classes');
});

app.get('/teacher/learners/:classId', authenticateToken, (req, res) => {
  res.redirect(307, `/api/teacher/learners/${req.params.classId}`);
});

app.get('/teacher/subjects/:classId', authenticateToken, (req, res) => {
  res.redirect(307, `/api/teacher/subjects/${req.params.classId}`);
});

app.get('/teacher/report-card/:learnerId', authenticateToken, (req, res) => {
  const { learnerId } = req.params;
  const { term, year } = req.query;
  const queryString = new URLSearchParams({ term, year }).toString();
  res.redirect(307, `/api/teacher/report-card/${learnerId}${queryString ? '?' + queryString : ''}`);
});

app.put('/teacher/report-card/:learnerId', authenticateToken, (req, res) => {
  const { learnerId } = req.params;
  const { term, year } = req.query;
  const queryString = new URLSearchParams({ term, year }).toString();
  res.redirect(307, `/api/teacher/report-card/${learnerId}${queryString ? '?' + queryString : ''}`);
});

app.get('/learner/attendance-stats', authenticateToken, (req, res) => {
  res.redirect(307, '/api/learner/attendance-stats');
});

app.get('/learner/attendance/today', authenticateToken, (req, res) => {
  res.redirect(307, '/api/learner/attendance/today');
});

app.post('/teacher/attendance/project', authenticateToken, (req, res) => {
  res.redirect(307, '/api/teacher/attendance/project');
});

// ==================== ADMIN ENDPOINTS ====================

// Get admin dashboard stats
app.get('/api/admin/stats', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    console.log('Fetching admin stats for user:', req.user.userId);

    const learnersResult = await pool.query('SELECT COUNT(*) as count FROM learners');
    const teachersResult = await pool.query("SELECT COUNT(*) as count FROM users WHERE role = 'teacher'");
    const classesResult = await pool.query('SELECT COUNT(*) as count FROM classes');

    const recentResult = await pool.query(
      `SELECT action, details, created_at
       FROM audit_logs
       ORDER BY created_at DESC
       LIMIT 5`
    );

    res.json({
      success: true,
      learners: parseInt(learnersResult.rows[0].count),
      teachers: parseInt(teachersResult.rows[0].count),
      classes: parseInt(classesResult.rows[0].count),
      recent_activities: recentResult.rows
    });

  } catch (err) {
    console.error('Error fetching admin stats:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Clear all audit logs (admin only)
app.delete('/api/admin/audit-logs/clear', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    // First, log this action
    await logAdminAction(
      req.user.userId,
      'CLEAR_LOGS',
      'Cleared all audit logs',
      req.ip
    );

    // Then delete all logs
    await pool.query('DELETE FROM audit_logs');

    res.json({
      success: true,
      message: 'All logs cleared successfully'
    });

  } catch (err) {
    console.error('Error clearing logs:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Get all teachers (for registration dropdowns)
app.get('/api/admin/teachers', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, email, department, specialization
       FROM users
       WHERE role = 'teacher'
       ORDER BY username ASC`
    );

    res.json({
      success: true,
      teachers: result.rows
    });
  } catch (err) {
    console.error('Error fetching teachers:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Register a new teacher
app.post('/api/admin/teachers', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { username, email, password, department, specialization, phone, address } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username, email, and password are required'
      });
    }

    // Check if email already exists
    const emailCheck = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (emailCheck.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Email already exists'
      });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, role, department, specialization, phone, address)
       VALUES ($1, $2, $3, 'teacher', $4, $5, $6, $7)
       RETURNING id, username, email, department, specialization, phone, address, created_at`,
      [username, email, passwordHash, department || null, specialization || null, phone || null, address || null]
    );

    await logAdminAction(
      req.user.userId,
      'REGISTER_TEACHER',
      `Registered teacher: ${username} (${email})`,
      req.ip
    );

    res.json({
      success: true,
      message: 'Teacher registered successfully',
      teacher: result.rows[0]
    });

  } catch (err) {
    console.error('Error registering teacher:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Get all classes
app.get('/api/admin/classes', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*,
              u.username as teacher_name,
              COUNT(l.id) as learner_count
       FROM classes c
       LEFT JOIN users u ON c.teacher_id = u.id
       LEFT JOIN learners l ON c.id = l.class_id
       GROUP BY c.id, u.username
       ORDER BY c.year DESC, c.name ASC`
    );

    res.json({
      success: true,
      classes: result.rows
    });
  } catch (err) {
    console.error('Error fetching classes:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Create a new class
app.post('/api/admin/classes', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { name, year, teacher_id } = req.body;

    if (!name || !year) {
      return res.status(400).json({
        success: false,
        message: 'Class name and year are required'
      });
    }

    const result = await pool.query(
      `INSERT INTO classes (name, year, teacher_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, year, teacher_id || null]
    );

    await logAdminAction(
      req.user.userId,
      'CREATE_CLASS',
      `Created class: ${name} (${year})`,
      req.ip
    );

    res.json({
      success: true,
      message: 'Class created successfully',
      class: result.rows[0]
    });

  } catch (err) {
    console.error('Error creating class:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Update a class
app.put('/api/admin/classes/:classId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { classId } = req.params;
    const { name, year, teacher_id } = req.body;

    const result = await pool.query(
      `UPDATE classes
       SET name = $1, year = $2, teacher_id = $3
       WHERE id = $4
       RETURNING *`,
      [name, year, teacher_id, classId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Class not found'
      });
    }

    await logAdminAction(
      req.user.userId,
      'UPDATE_CLASS',
      `Updated class ID ${classId}`,
      req.ip
    );

    res.json({
      success: true,
      message: 'Class updated successfully',
      class: result.rows[0]
    });

  } catch (err) {
    console.error('Error updating class:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Delete a class
app.delete('/api/admin/classes/:classId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { classId } = req.params;

    // Check if class has learners
    const checkResult = await pool.query(
      'SELECT COUNT(*) as count FROM learners WHERE class_id = $1',
      [classId]
    );

    if (parseInt(checkResult.rows[0].count) > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete class with enrolled learners'
      });
    }

    const result = await pool.query(
      'DELETE FROM classes WHERE id = $1 RETURNING *',
      [classId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Class not found'
      });
    }

    await logAdminAction(
      req.user.userId,
      'DELETE_CLASS',
      `Deleted class ID ${classId}: ${result.rows[0].name}`,
      req.ip
    );

    res.json({
      success: true,
      message: 'Class deleted successfully'
    });

  } catch (err) {
    console.error('Error deleting class:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Get all subjects for a class (admin version)
app.get('/api/admin/subjects/:classId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { classId } = req.params;

    const result = await pool.query(
      `SELECT st.id,
              st.subject_name as name,
              st.total_marks,
              st.display_order
       FROM subject_templates st
       WHERE st.class_id = $1
       ORDER BY st.display_order ASC, st.subject_name ASC`,
      [classId]
    );

    res.json({
      success: true,
      subjects: result.rows
    });

  } catch (err) {
    console.error('Error fetching subjects:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Create a new subject
app.post('/api/admin/subjects', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { class_id, subject_name, total_marks, display_order } = req.body;

    if (!class_id || !subject_name || !total_marks) {
      return res.status(400).json({
        success: false,
        message: 'Class ID, subject name, and total marks are required'
      });
    }

    const result = await pool.query(
      `INSERT INTO subject_templates (class_id, subject_name, total_marks, display_order)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [class_id, subject_name, total_marks, display_order || 0]
    );

    await logAdminAction(
      req.user.userId,
      'CREATE_SUBJECT',
      `Created subject: ${subject_name} for class ${class_id}`,
      req.ip
    );

    res.json({
      success: true,
      message: 'Subject created successfully',
      subject: result.rows[0]
    });

  } catch (err) {
    console.error('Error creating subject:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Update a subject
app.put('/api/admin/subjects/:subjectId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { subjectId } = req.params;
    const { subject_name, total_marks, display_order } = req.body;

    const result = await pool.query(
      `UPDATE subject_templates
       SET subject_name = $1, total_marks = $2, display_order = $3
       WHERE id = $4
       RETURNING *`,
      [subject_name, total_marks, display_order, subjectId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Subject not found'
      });
    }

    await logAdminAction(
      req.user.userId,
      'UPDATE_SUBJECT',
      `Updated subject ID ${subjectId}`,
      req.ip
    );

    res.json({
      success: true,
      message: 'Subject updated successfully',
      subject: result.rows[0]
    });

  } catch (err) {
    console.error('Error updating subject:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Delete a subject
app.delete('/api/admin/subjects/:subjectId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { subjectId } = req.params;

    // Check if subject has results
    const checkResult = await pool.query(
      'SELECT COUNT(*) as count FROM subject_results WHERE template_id = $1',
      [subjectId]
    );

    if (parseInt(checkResult.rows[0].count) > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete subject with existing results'
      });
    }

    const result = await pool.query(
      'DELETE FROM subject_templates WHERE id = $1 RETURNING *',
      [subjectId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Subject not found'
      });
    }

    await logAdminAction(
      req.user.userId,
      'DELETE_SUBJECT',
      `Deleted subject ID ${subjectId}: ${result.rows[0].subject_name}`,
      req.ip
    );

    res.json({
      success: true,
      message: 'Subject deleted successfully'
    });

  } catch (err) {
    console.error('Error deleting subject:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Get all learners (admin view)
app.get('/api/admin/learners', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, c.name as class_name
       FROM learners l
       LEFT JOIN classes c ON l.class_id = c.id
       ORDER BY l.username ASC`
    );

    res.json({
      success: true,
      learners: result.rows
    });
  } catch (err) {
    console.error('Error fetching learners:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Register a new learner
app.post('/api/admin/learners', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { username, reg_number, class_id } = req.body;

    if (!username || !reg_number || !class_id) {
      return res.status(400).json({
        success: false,
        message: 'Username, registration number, and class are required'
      });
    }

    // Check if reg_number already exists
    const checkResult = await pool.query(
      'SELECT id FROM learners WHERE reg_number = $1',
      [reg_number]
    );

    if (checkResult.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Registration number already exists'
      });
    }

    const result = await pool.query(
      `INSERT INTO learners (username, reg_number, class_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [username, reg_number, class_id]
    );

    await logAdminAction(
      req.user.userId,
      'REGISTER_LEARNER',
      `Registered learner: ${username} (${reg_number})`,
      req.ip
    );

    res.json({
      success: true,
      message: 'Learner registered successfully',
      learner: result.rows[0]
    });

  } catch (err) {
    console.error('Error registering learner:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Update a learner
app.put('/api/admin/learners/:learnerId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { learnerId } = req.params;
    const { username, reg_number, class_id } = req.body;

    // Check if reg_number already exists for another learner
    const checkResult = await pool.query(
      'SELECT id FROM learners WHERE reg_number = $1 AND id != $2',
      [reg_number, learnerId]
    );

    if (checkResult.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Registration number already exists'
      });
    }

    const result = await pool.query(
      `UPDATE learners
       SET username = $1, reg_number = $2, class_id = $3
       WHERE id = $4
       RETURNING *`,
      [username, reg_number, class_id, learnerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Learner not found'
      });
    }

    await logAdminAction(
      req.user.userId,
      'UPDATE_LEARNER',
      `Updated learner ID ${learnerId}`,
      req.ip
    );

    res.json({
      success: true,
      message: 'Learner updated successfully',
      learner: result.rows[0]
    });

  } catch (err) {
    console.error('Error updating learner:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Delete a learner
app.delete('/api/admin/learners/:learnerId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { learnerId } = req.params;

    // Check if learner has attendance records
    const checkAttendance = await pool.query(
      'SELECT COUNT(*) as count FROM attendance WHERE learner_id = $1',
      [learnerId]
    );

    if (parseInt(checkAttendance.rows[0].count) > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete learner with attendance records'
      });
    }

    // Check if learner has report cards
    const checkReports = await pool.query(
      'SELECT COUNT(*) as count FROM report_cards WHERE learner_id = $1',
      [learnerId]
    );

    if (parseInt(checkReports.rows[0].count) > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete learner with report cards'
      });
    }

    const result = await pool.query(
      'DELETE FROM learners WHERE id = $1 RETURNING *',
      [learnerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Learner not found'
      });
    }

    await logAdminAction(
      req.user.userId,
      'DELETE_LEARNER',
      `Deleted learner ID ${learnerId}: ${result.rows[0].username}`,
      req.ip
    );

    res.json({
      success: true,
      message: 'Learner deleted successfully'
    });

  } catch (err) {
    console.error('Error deleting learner:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Get security logs
app.get('/api/admin/audit-logs', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;

    const result = await pool.query(
      `SELECT al.*, u.username
       FROM audit_logs al
       LEFT JOIN users u ON al.user_id = u.id
       ORDER BY al.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await pool.query('SELECT COUNT(*) as count FROM audit_logs');

    res.json({
      success: true,
      logs: result.rows,
      total: parseInt(countResult.rows[0].count)
    });

  } catch (err) {
    console.error('Error fetching audit logs:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(500).json({
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    message: 'Route not found',
    path: req.url
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing database pool...');
  await pool.end();
  process.exit(0);
});

// ==================== START SERVER ====================
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`📝 Health check: http://localhost:${port}/health`);
  console.log(`🔍 API status: http://localhost:${port}/api/health`);
  console.log(`🔧 Test connection: http://localhost:${port}/api/test-connection`);
  console.log(`✅ All API endpoints use /api prefix consistently`);
  console.log(`📢 Announcement endpoints added:`);
  console.log(`   - POST   /api/teacher/announcements`);
  console.log(`   - GET    /api/teacher/announcements`);
  console.log(`   - DELETE /api/teacher/announcements/:id`);
  console.log(`   - GET    /api/learner/announcements`);
  console.log(`📊 Attendance endpoints updated with term/year filtering`);
  console.log(`🌐 CORS enabled for: https://sukulu.netlify.app`);
});

module.exports = app;