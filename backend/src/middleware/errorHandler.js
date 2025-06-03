const winston = require('winston');

const logger = winston.createLogger({
  level: 'error',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log' })
  ]
});

class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;

  // Log error
  logger.error('Error:', {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  // Default error
  let message = 'Internal server error';
  let statusCode = 500;
  let code = 'E500';

  // Operational errors
  if (err.isOperational) {
    message = err.message;
    statusCode = err.statusCode;
    code = err.code;
  }

  // PostgreSQL errors
  if (err.code && err.code.startsWith('23')) {
    if (err.code === '23505') {
      // Unique violation
      if (err.constraint && err.constraint.includes('username')) {
        message = 'Username already exists';
        code = 'E003';
      } else if (err.constraint && err.constraint.includes('email')) {
        message = 'Email already exists';
        code = 'E003';
      } else {
        message = 'Duplicate entry';
        code = 'E003';
      }
      statusCode = 409;
    } else if (err.code === '23503') {
      // Foreign key violation
      message = 'Referenced record not found';
      statusCode = 400;
      code = 'E400';
    }
  }

  // Validation errors (Joi)
  if (err.isJoi) {
    message = err.details[0].message;
    statusCode = 400;
    code = 'E400';
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    message = 'Invalid token';
    statusCode = 401;
    code = 'E002';
  }

  if (err.name === 'TokenExpiredError') {
    message = 'Token expired';
    statusCode = 401;
    code = 'E002';
  }

  res.status(statusCode).json({
    error: message,
    code: code,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

// Async error handler
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
  AppError,
  errorHandler,
  asyncHandler
};
