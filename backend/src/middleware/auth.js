const jwt = require('jsonwebtoken');
const { query } = require('../database/connection');
const { getSession } = require('../redis/connection');
const crypto = require('crypto');

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Access token required',
        code: 'E002'
      });
    }

    const token = authHeader.substring(7);
    
    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          error: 'Token expired',
          code: 'E002'
        });
      }
      return res.status(401).json({
        error: 'Invalid token',
        code: 'E002'
      });
    }

    // Check if user still exists
    const userResult = await query(
      'SELECT id, username, email, timezone FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        error: 'User not found',
        code: 'E002'
      });
    }

    // Attach user to request
    req.user = userResult.rows[0];
    req.userId = decoded.userId;
    
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'E500'
    });
  }
}

// Optional authentication - doesn't fail if no token
async function optionalAuthenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(); // Continue without authentication
    }

    const token = authHeader.substring(7);
    
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      const userResult = await query(
        'SELECT id, username, email, timezone FROM users WHERE id = $1',
        [decoded.userId]
      );

      if (userResult.rows.length > 0) {
        req.user = userResult.rows[0];
        req.userId = decoded.userId;
      }
    } catch (error) {
      // Token invalid, but continue without authentication
    }
    
    next();
  } catch (error) {
    console.error('Optional authentication error:', error);
    next(); // Continue even if there's an error
  }
}

// Generate JWT tokens
function generateTokens(userId) {
  const accessToken = jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
  );

  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );

  return { accessToken, refreshToken };
}

// Helper function to hash tokens
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Verify refresh token
async function verifyRefreshToken(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    
    if (decoded.type !== 'refresh') {
      throw new Error('Invalid token type');
    }

    const hashedToken = hashToken(token);
    // Check if refresh token exists in database
    const tokenResult = await query(
      'SELECT user_id FROM refresh_tokens WHERE token_hash = $1 AND expires_at > NOW()',
      [hashedToken]
    );

    if (tokenResult.rows.length === 0) {
      throw new Error('Refresh token not found or expired');
    }

    return decoded;
  } catch (error) {
    throw new Error('Invalid refresh token');
  }
}

// Store refresh token in database
async function storeRefreshToken(userId, refreshToken, deviceInfo = {}) {
  const hashedToken = hashToken(refreshToken);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_info, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
    [userId, hashedToken, JSON.stringify(deviceInfo)]
  );
}

// Revoke refresh token
async function revokeRefreshToken(refreshToken) {
  const hashedToken = hashToken(refreshToken);
  await query(
    'DELETE FROM refresh_tokens WHERE token_hash = $1',
    [hashedToken]
  );
}

// Revoke all refresh tokens for user
async function revokeAllRefreshTokens(userId) {
  await query(
    'DELETE FROM refresh_tokens WHERE user_id = $1',
    [userId]
  );
}

module.exports = {
  authenticate,
  optionalAuthenticate,
  generateTokens,
  verifyRefreshToken,
  storeRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens
};
