# Screen Time Game - Backend API

A gamified backend server that rewards users for reducing screen time by keeping their phones locked. Built with Node.js, Express, PostgreSQL, and Redis.

## Features

- **JWT Authentication** with refresh tokens
- **PostgreSQL Database** with comprehensive schema
- **Redis Caching** for sessions and rate limiting
- **S-Curve Scoring Algorithm** (2-minute minimum, 120-minute plateau)
- **Anti-Tampering Protection** with anomaly detection
- **Group Competitions** with leaderboards
- **Real-time Updates** via WebSocket
- **Weekly Score Processing** with automated cron jobs
- **Docker Support** for easy deployment
- **Comprehensive API Documentation**

## Quick Start

### Prerequisites

- Node.js 18+ 
- PostgreSQL 13+
- Redis 6+
- Docker (optional)

### Environment Setup

1. Clone the repository and navigate to the backend directory
2. Copy the environment template:
   ```bash
   cp .env.example .env
   ```

3. Update the `.env` file with your configuration:
   ```env
   # Database
   DATABASE_URL=postgresql://username:password@localhost:5432/screen_time_game
   
   # Redis
   REDIS_URL=redis://localhost:6379
   
   # JWT
   JWT_SECRET=your-super-secret-jwt-key-here
   JWT_EXPIRES_IN=15m
   REFRESH_TOKEN_EXPIRES_IN=7d
   
   # Server
   PORT=3000
   NODE_ENV=development
   
   # Rate Limiting
   RATE_LIMIT_WINDOW_MS=900000
   RATE_LIMIT_MAX_REQUESTS=100
   
   # CORS
   CORS_ORIGIN=http://localhost:3000
   ```

### Installation & Running

#### Option 1: Docker (Recommended)

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

#### Option 2: Manual Setup

```bash
# Install dependencies
npm install

# Set up database
createdb screen_time_game
psql screen_time_game < src/database/init.sql

# Start Redis (if not running)
redis-server

# Run in development mode
npm run dev

# Or run in production mode
npm start
```

## API Documentation

### Authentication

#### Register User
```http
POST /api/auth/register
Content-Type: application/json

{
  "username": "john_doe",
  "email": "john@example.com",
  "password": "SecurePass123!",
  "timezone": "America/New_York"
}
```

#### Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "SecurePass123!"
}
```

#### Refresh Token
```http
POST /api/auth/refresh
Content-Type: application/json

{
  "refresh_token": "your-refresh-token"
}
```

### Screen Events

#### Upload Events (Batch)
```http
POST /api/events/upload
Authorization: Bearer your-jwt-token
Content-Type: application/json

{
  "events": [
    {
      "locked_at": "2025-06-03T10:00:00Z",
      "unlocked_at": "2025-06-03T10:30:00Z",
      "duration_minutes": 30
    }
  ],
  "device_info": {
    "platform": "android",
    "version": "14.0"
  }
}
```

### Scores

#### Get Current Week Score
```http
GET /api/scores/current
Authorization: Bearer your-jwt-token
```

#### Get Score History
```http
GET /api/scores/history?weeks=10&offset=0
Authorization: Bearer your-jwt-token
```

#### Get Global Leaderboard
```http
GET /api/scores/leaderboard
Authorization: Bearer your-jwt-token
```

### Groups

#### Create Group
```http
POST /api/groups/create
Authorization: Bearer your-jwt-token
Content-Type: application/json

{
  "name": "Study Buddies",
  "description": "Focused study group",
  "is_private": false
}
```

#### Join Group
```http
POST /api/groups/join
Authorization: Bearer your-jwt-token
Content-Type: application/json

{
  "group_id": 123
}
```

#### Get Group Leaderboard
```http
GET /api/groups/123/leaderboard
Authorization: Bearer your-jwt-token
```

### User Profile

#### Get Profile
```http
GET /api/users/profile
Authorization: Bearer your-jwt-token
```

#### Update Profile
```http
PUT /api/users/profile
Authorization: Bearer your-jwt-token
Content-Type: application/json

{
  "username": "new_username",
  "timezone": "Europe/London"
}
```

### WebSocket Connection

Connect to WebSocket for real-time updates:

```javascript
const ws = new WebSocket('ws://localhost:3000/ws?token=your-jwt-token');

ws.onopen = () => {
  // Join group leaderboard
  ws.send(JSON.stringify({
    type: 'join_group_leaderboard',
    groupId: 123
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  switch (data.type) {
    case 'global_leaderboard':
      // Update global leaderboard UI
      break;
    case 'group_leaderboard':
      // Update group leaderboard UI
      break;
  }
};
```

## Scoring Algorithm

The app uses an S-curve scoring algorithm:

- **0-2 minutes**: 0 points (minimum threshold)
- **2-120 minutes**: Exponential growth
- **120+ minutes**: Plateau (diminishing returns)

```javascript
// Examples
calculateSessionScore(2);   // 1 point
calculateSessionScore(30);  // 75 points  
calculateSessionScore(60);  // 150 points
calculateSessionScore(120); // 200 points (plateau start)
calculateSessionScore(240); // ~210 points (plateau)
```

## Database Schema

### Core Tables

- **users**: User accounts and profiles
- **screen_events**: Phone lock/unlock events
- **weekly_scores**: Calculated weekly scores
- **groups**: Group competitions
- **group_members**: Group membership
- **refresh_tokens**: JWT refresh tokens
- **device_certificates**: Device validation

### Key Features

- **Indexes** on frequently queried columns
- **Foreign key constraints** for data integrity
- **Timestamp tracking** for all records
- **Soft delete** patterns where applicable

## Security Features

### Anti-Tampering

- **Event sequence validation**: Detects overlapping sessions
- **Anomaly detection**: Flags suspicious patterns
- **Device registration**: Links events to verified devices
- **Rate limiting**: Prevents API abuse
- **Input validation**: Comprehensive request validation

### Authentication

- **JWT tokens** with short expiration (15 minutes)
- **Refresh tokens** with longer expiration (7 days)
- **Secure password hashing** with bcrypt
- **Device-specific tokens** for enhanced security

## Development

### Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Test scoring algorithm
node scripts/test-scoring.js
```

### Database Migration

```bash
# Run database migrations
npm run db:migrate

# Seed test data
npm run db:seed
```

### Monitoring

The server provides several monitoring endpoints:

- `GET /health` - Health check
- WebSocket statistics via `wsServer.getStats()`
- Winston logging to files and console

### Weekly Processing

The server automatically processes weekly scores every Sunday at 23:59 UTC and cleans up old data every Monday at 01:00 UTC.

To manually trigger processing:

```javascript
const weeklyResetService = require('./src/services/weeklyReset');

// Process current week
await weeklyResetService.processWeeklyScores();

// Reprocess specific week
await weeklyResetService.reprocessWeek(2025, 23);

// Cleanup old data
await weeklyResetService.cleanupOldData();
```

## Deployment

### Docker Production

```bash
# Build and start
docker-compose -f docker-compose.yml up -d

# Scale if needed
docker-compose up -d --scale app=3
```

### Manual Production

```bash
# Install production dependencies
npm ci --production

# Set environment
export NODE_ENV=production

# Start with PM2
npm install -g pm2
pm2 start src/server.js --name screen-time-api

# Or use systemd service
sudo systemctl start screen-time-game
```

## API Error Codes

- **E001**: Rate limit exceeded
- **E002**: Authentication required
- **E003**: Invalid credentials
- **E004**: Registration failed
- **E005**: User not found
- **E006-E008**: Profile update errors
- **E009-E019**: Event processing errors
- **E020-E031**: Group management errors

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## License

MIT License - see LICENSE file for details.
