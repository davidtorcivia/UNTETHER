// Mock the services that require database/redis before importing the app
jest.mock('../src/services/weeklyReset', () => ({
  startScheduler: jest.fn(),
  processWeeklyScores: jest.fn(),
  cleanupOldData: jest.fn()
}));

jest.mock('../src/services/websocket', () => {
  return jest.fn().mockImplementation(() => ({
    getStats: jest.fn(() => ({ totalUsers: 0, totalConnections: 0 })),
    close: jest.fn()
  }));
});

const request = require('supertest');

describe('Health Check', () => {
  let app;

  beforeAll(() => {
    // Import app after mocks are set up
    app = require('../src/server');
  });

  test('GET /health should return healthy status', async () => {
    const response = await request(app)
      .get('/health')
      .expect(200);

    expect(response.body).toHaveProperty('status', 'healthy');
    expect(response.body).toHaveProperty('timestamp');
    expect(response.body).toHaveProperty('version');
  });
});

describe('API Endpoints', () => {
  let app;

  beforeAll(() => {
    app = require('../src/server');
  });

  test('POST /api/auth/register should require valid data', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({})
      .expect(400);

    expect(response.body).toHaveProperty('error');
  });

  test('GET /api/scores/current should require authentication', async () => {
    const response = await request(app)
      .get('/api/scores/current')
      .expect(401);

    expect(response.body).toHaveProperty('error');
    expect(response.body).toHaveProperty('code', 'E002');
  });

  test('GET /api/groups/search should require authentication', async () => {
    const response = await request(app)
      .get('/api/groups/search')
      .expect(401);

    expect(response.body).toHaveProperty('error');
    expect(response.body).toHaveProperty('code', 'E002');
  });

  test('GET /nonexistent should return 404', async () => {
    const response = await request(app)
      .get('/nonexistent')
      .expect(404);

    expect(response.body).toHaveProperty('error', 'Endpoint not found');
    expect(response.body).toHaveProperty('code', 'E404');
  });
});
