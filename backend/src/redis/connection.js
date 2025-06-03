const redis = require('redis');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console()
  ]
});

let client;

async function connectRedis() {
  try {
    client = redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      retry_strategy: (options) => {
        if (options.error && options.error.code === 'ECONNREFUSED') {
          logger.error('Redis server refused the connection');
        }
        if (options.total_retry_time > 1000 * 60 * 60) {
          logger.error('Retry time exhausted');
          return new Error('Retry time exhausted');
        }
        if (options.attempt > 10) {
          logger.error('Too many retry attempts');
          return undefined;
        }
        // reconnect after
        return Math.min(options.attempt * 100, 3000);
      }
    });

    client.on('error', (err) => {
      logger.error('Redis Client Error:', err);
    });

    client.on('connect', () => {
      logger.info('Redis connected successfully');
    });

    client.on('ready', () => {
      logger.info('Redis ready to accept commands');
    });

    await client.connect();
    
    // Test connection
    await client.ping();
    
    return client;
  } catch (error) {
    logger.error('Redis connection failed:', error);
    throw error;
  }
}

function getRedisClient() {
  if (!client) {
    throw new Error('Redis not connected. Call connectRedis() first.');
  }
  return client;
}

// Helper functions for common Redis operations
async function setWithExpiry(key, value, expiry) {
  try {
    await client.setEx(key, expiry, JSON.stringify(value));
  } catch (error) {
    logger.error('Redis SET error:', error);
    throw error;
  }
}

async function get(key) {
  try {
    const value = await client.get(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    logger.error('Redis GET error:', error);
    throw error;
  }
}

async function del(key) {
  try {
    return await client.del(key);
  } catch (error) {
    logger.error('Redis DEL error:', error);
    throw error;
  }
}

async function exists(key) {
  try {
    return await client.exists(key);
  } catch (error) {
    logger.error('Redis EXISTS error:', error);
    throw error;
  }
}

// Session management helpers
async function setSession(sessionId, sessionData, expiry = 3600) {
  const key = `session:${sessionId}`;
  await setWithExpiry(key, sessionData, expiry);
}

async function getSession(sessionId) {
  const key = `session:${sessionId}`;
  return await get(key);
}

async function deleteSession(sessionId) {
  const key = `session:${sessionId}`;
  return await del(key);
}

// Rate limiting helpers
async function incrementRateLimit(identifier, window = 900) {
  const key = `rate_limit:${identifier}`;
  const current = await client.incr(key);
  
  if (current === 1) {
    await client.expire(key, window);
  }
  
  return current;
}

async function getRateLimit(identifier) {
  const key = `rate_limit:${identifier}`;
  const count = await client.get(key);
  const ttl = await client.ttl(key);
  
  return {
    count: parseInt(count) || 0,
    ttl: ttl
  };
}

module.exports = {
  connectRedis,
  getRedisClient,
  setWithExpiry,
  get,
  del,
  exists,
  setSession,
  getSession,
  deleteSession,
  incrementRateLimit,
  getRateLimit
};
