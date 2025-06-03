const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../database/connection');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const Joi = require('joi');

const router = express.Router();

// Validation schemas
const updateProfileSchema = Joi.object({
  username: Joi.string().alphanum().min(3).max(30).optional(),
  timezone: Joi.string().max(50).optional(),
  email: Joi.string().email().max(255).optional()
});

const searchUsersSchema = Joi.object({
  query: Joi.string().min(3).max(50).required()
});

// Get own profile
router.get('/profile', authenticate, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id, username, email, timezone, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        code: 'E005'
      });
    }

    res.json({
      user: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

// Update profile
router.put('/profile', authenticate, validate(updateProfileSchema), async (req, res, next) => {
  try {
    const { username, timezone, email } = req.body;
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (username) {
      // Check if username is already taken
      const existingUser = await db.query(
        'SELECT id FROM users WHERE username = $1 AND id != $2',
        [username, req.user.id]
      );

      if (existingUser.rows.length > 0) {
        return res.status(409).json({
          error: 'Username already taken',
          code: 'E006'
        });
      }

      updates.push(`username = $${paramIndex++}`);
      values.push(username);
    }

    if (timezone) {
      updates.push(`timezone = $${paramIndex++}`);
      values.push(timezone);
    }

    if (email) {
      // Check if email is already taken
      const existingEmail = await db.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [email, req.user.id]
      );

      if (existingEmail.rows.length > 0) {
        return res.status(409).json({
          error: 'Email already taken',
          code: 'E007'
        });
      }

      updates.push(`email = $${paramIndex++}`);
      values.push(email);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: 'No valid fields to update',
        code: 'E008'
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(req.user.id);

    const query = `
      UPDATE users 
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, username, email, timezone, updated_at
    `;

    const result = await db.query(query, values);

    res.json({
      message: 'Profile updated successfully',
      user: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

// Search users by username
router.get('/search', authenticate, validate(searchUsersSchema, 'query'), async (req, res, next) => {
  try {
    const { query } = req.query;

    const result = await db.query(
      `SELECT id, username, created_at 
       FROM users 
       WHERE username ILIKE $1 
       AND id != $2
       ORDER BY username 
       LIMIT 20`,
      [`%${query}%`, req.user.id]
    );

    res.json({
      users: result.rows
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
