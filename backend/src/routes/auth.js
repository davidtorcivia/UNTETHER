const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database/connection');
const { validate, schemas } = require('../middleware/validation');
const { 
  generateTokens, 
  verifyRefreshToken, 
  storeRefreshToken, 
  revokeRefreshToken,
  revokeAllRefreshTokens 
} = require('../middleware/auth');
const { asyncHandler, AppError } = require('../middleware/errorHandler');

const router = express.Router();

// Register new user
router.post('/register', validate(schemas.register), asyncHandler(async (req, res) => {
  const { username, email, password, timezone = 'UTC' } = req.body;

  // Hash password
  const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
  const passwordHash = await bcrypt.hash(password, saltRounds);

  try {
    // Insert user
    const result = await query(
      `INSERT INTO users (username, email, password_hash, timezone)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, timezone, created_at`,
      [username, email, passwordHash, timezone]
    );

    const user = result.rows[0];

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user.id);

    // Store refresh token
    await storeRefreshToken(user.id, refreshToken, {
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });

    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        timezone: user.timezone,
        createdAt: user.created_at
      },
      tokens: {
        accessToken,
        refreshToken
      }
    });

  } catch (error) {
    if (error.code === '23505') {
      if (error.constraint.includes('username')) {
        throw new AppError('Username already exists', 409, 'E003');
      } else if (error.constraint.includes('email')) {
        throw new AppError('Email already exists', 409, 'E003');
      }
    }
    throw error;
  }
}));

// Login user
router.post('/login', validate(schemas.login), asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  // Find user by email
  const result = await query(
    'SELECT id, username, email, password_hash, timezone FROM users WHERE email = $1',
    [email]
  );

  if (result.rows.length === 0) {
    throw new AppError('Invalid credentials', 401, 'E002');
  }

  const user = result.rows[0];

  // Verify password
  const isValidPassword = await bcrypt.compare(password, user.password_hash);
  
  if (!isValidPassword) {
    throw new AppError('Invalid credentials', 401, 'E002');
  }

  // Generate tokens
  const { accessToken, refreshToken } = generateTokens(user.id);

  // Store refresh token
  await storeRefreshToken(user.id, refreshToken, {
    userAgent: req.get('User-Agent'),
    ip: req.ip
  });

  res.json({
    message: 'Login successful',
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      timezone: user.timezone
    },
    tokens: {
      accessToken,
      refreshToken
    }
  });
}));

// Refresh access token
router.post('/refresh', validate(schemas.refreshToken), asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  try {
    // Verify refresh token
    const decoded = await verifyRefreshToken(refreshToken);

    // Generate new access token
    const { accessToken } = generateTokens(decoded.userId);

    res.json({
      accessToken
    });

  } catch (error) {
    throw new AppError('Invalid refresh token', 401, 'E002');
  }
}));

// Logout user (revoke refresh token)
router.post('/logout', validate(schemas.refreshToken), asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  try {
    await revokeRefreshToken(refreshToken);
    
    res.json({
      message: 'Logout successful'
    });
  } catch (error) {
    // Even if token is invalid, consider logout successful
    res.json({
      message: 'Logout successful'
    });
  }
}));

// Logout from all devices
router.post('/logout-all', validate(schemas.refreshToken), asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  try {
    // Verify token to get user ID
    const decoded = await verifyRefreshToken(refreshToken);
    
    // Revoke all refresh tokens for this user
    await revokeAllRefreshTokens(decoded.userId);
    
    res.json({
      message: 'Logged out from all devices'
    });
  } catch (error) {
    throw new AppError('Invalid refresh token', 401, 'E002');
  }
}));

// Register device (for anti-tampering)
router.post('/register-device', validate(schemas.deviceRegistration), asyncHandler(async (req, res) => {
  const { deviceId, deviceModel, platform, appSignature } = req.body;

  // In a real implementation, you would verify the app signature here
  // For now, we'll just store the device info

  const certificateHash = uuidv4(); // Generate a unique certificate

  // This endpoint would typically require authentication
  // For initial device registration, we might use a different flow

  res.json({
    certificate: certificateHash,
    message: 'Device registered successfully'
  });
}));

module.exports = router;
