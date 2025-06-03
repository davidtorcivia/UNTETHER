// Test setup file to mock database and redis connections
const mockDb = {
  query: jest.fn(),
  connect: jest.fn(() => ({
    query: jest.fn(),
    release: jest.fn()
  }))
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  exists: jest.fn(),
  expire: jest.fn()
};

// Mock the database connection module
jest.mock('../src/database/connection', () => ({
  db: mockDb,
  connectDatabase: jest.fn()
}));

// Mock the redis connection module
jest.mock('../src/redis/connection', () => ({
  redis: mockRedis,
  connectRedis: jest.fn()
}));

// Mock environment variables
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing';
process.env.JWT_EXPIRES_IN = '15m';
process.env.REFRESH_TOKEN_EXPIRES_IN = '7d';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';

global.mockDb = mockDb;
global.mockRedis = mockRedis;
