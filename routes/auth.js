const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');

const router = express.Router();

// Teacher/Admin login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Learner login
router.post('/learner-login', async (req, res) => {
  try {
    const { username, registrationNumber } = req.body;

    const result = await pool.query(
      'SELECT * FROM learners WHERE LOWER(username) = LOWER($1) AND reg_number = $2',
      [username, registrationNumber]
    );
    const learner = result.rows[0];

    if (!learner) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: learner.id, role: 'learner', username: learner.username },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token, user: { id: learner.id, username: learner.username, role: 'learner' } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;