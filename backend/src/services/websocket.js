const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { db } = require('../database/connection');
const { redis } = require('../redis/connection');

class WebSocketServer {
  constructor(server) {
    this.wss = new WebSocket.Server({ 
      server,
      path: '/ws',
      verifyClient: this.verifyClient.bind(this)
    });
    
    this.clients = new Map(); // userId -> Set of WebSocket connections
    this.groupClients = new Map(); // groupId -> Set of WebSocket connections
    
    this.wss.on('connection', this.handleConnection.bind(this));
    
    console.log('WebSocket server initialized');
  }

  /**
   * Verify client authentication before WebSocket upgrade
   */
  async verifyClient(info) {
    try {
      const url = new URL(info.req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      
      if (!token) {
        return false;
      }

      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Check if user exists
      const userResult = await db.query(
        'SELECT id, username FROM users WHERE id = $1',
        [decoded.id]
      );

      if (userResult.rows.length === 0) {
        return false;
      }

      // Attach user info to request for later use
      info.req.user = userResult.rows[0];
      return true;

    } catch (error) {
      console.error('WebSocket authentication error:', error);
      return false;
    }
  }

  /**
   * Handle new WebSocket connection
   */
  handleConnection(ws, req) {
    const user = req.user;
    console.log(`WebSocket connected: user ${user.id} (${user.username})`);

    // Add client to user connections
    if (!this.clients.has(user.id)) {
      this.clients.set(user.id, new Set());
    }
    this.clients.get(user.id).add(ws);

    // Set up message handlers
    ws.on('message', (data) => this.handleMessage(ws, user, data));
    ws.on('close', () => this.handleDisconnection(ws, user));
    ws.on('error', (error) => console.error('WebSocket error:', error));

    // Send initial connection confirmation
    this.sendToClient(ws, {
      type: 'connected',
      user: {
        id: user.id,
        username: user.username
      }
    });

    // Send current leaderboard
    this.sendCurrentLeaderboard(ws);
  }

  /**
   * Handle incoming WebSocket messages
   */
  async handleMessage(ws, user, data) {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'join_group_leaderboard':
          await this.handleJoinGroupLeaderboard(ws, user, message.groupId);
          break;

        case 'leave_group_leaderboard':
          this.handleLeaveGroupLeaderboard(ws, user, message.groupId);
          break;

        case 'ping':
          this.sendToClient(ws, { type: 'pong' });
          break;

        default:
          console.log('Unknown message type:', message.type);
      }

    } catch (error) {
      console.error('Error handling WebSocket message:', error);
      this.sendToClient(ws, {
        type: 'error',
        message: 'Invalid message format'
      });
    }
  }

  /**
   * Handle user joining a group leaderboard
   */
  async handleJoinGroupLeaderboard(ws, user, groupId) {
    try {
      // Verify user is a member of the group
      const memberCheck = await db.query(
        'SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2',
        [groupId, user.id]
      );

      if (memberCheck.rows.length === 0) {
        this.sendToClient(ws, {
          type: 'error',
          message: 'Access denied - not a member of this group'
        });
        return;
      }

      // Add client to group connections
      if (!this.groupClients.has(groupId)) {
        this.groupClients.set(groupId, new Set());
      }
      this.groupClients.get(groupId).add({ ws, userId: user.id });

      // Send current group leaderboard
      await this.sendGroupLeaderboard(groupId);

      console.log(`User ${user.id} joined group ${groupId} leaderboard`);

    } catch (error) {
      console.error('Error joining group leaderboard:', error);
      this.sendToClient(ws, {
        type: 'error',
        message: 'Failed to join group leaderboard'
      });
    }
  }

  /**
   * Handle user leaving a group leaderboard
   */
  handleLeaveGroupLeaderboard(ws, user, groupId) {
    if (this.groupClients.has(groupId)) {
      const groupConnections = this.groupClients.get(groupId);
      // Remove connections for this user
      for (const connection of groupConnections) {
        if (connection.userId === user.id && connection.ws === ws) {
          groupConnections.delete(connection);
        }
      }

      if (groupConnections.size === 0) {
        this.groupClients.delete(groupId);
      }
    }

    console.log(`User ${user.id} left group ${groupId} leaderboard`);
  }

  /**
   * Handle WebSocket disconnection
   */
  handleDisconnection(ws, user) {
    console.log(`WebSocket disconnected: user ${user.id}`);

    // Remove from user connections
    if (this.clients.has(user.id)) {
      this.clients.get(user.id).delete(ws);
      if (this.clients.get(user.id).size === 0) {
        this.clients.delete(user.id);
      }
    }

    // Remove from all group connections
    for (const [groupId, connections] of this.groupClients.entries()) {
      for (const connection of connections) {
        if (connection.userId === user.id && connection.ws === ws) {
          connections.delete(connection);
        }
      }
      
      if (connections.size === 0) {
        this.groupClients.delete(groupId);
      }
    }
  }

  /**
   * Send current global leaderboard to a client
   */
  async sendCurrentLeaderboard(ws) {
    try {
      // Get current week info
      const currentWeekQuery = `
        SELECT 
          EXTRACT(YEAR FROM date_trunc('week', CURRENT_DATE)) as year,
          EXTRACT(WEEK FROM date_trunc('week', CURRENT_DATE)) as week
      `;
      
      const weekResult = await db.query(currentWeekQuery);
      const { year, week } = weekResult.rows[0];

      // Get top 20 users for current week
      const leaderboardQuery = `
        SELECT 
          u.id,
          u.username,
          ws.score,
          ws.total_locked_minutes,
          ws.sessions_count,
          ROW_NUMBER() OVER (ORDER BY ws.score DESC, ws.total_locked_minutes DESC) as rank
        FROM weekly_scores ws
        JOIN users u ON ws.user_id = u.id
        WHERE ws.year = $1 AND ws.week = $2
        ORDER BY ws.score DESC, ws.total_locked_minutes DESC
        LIMIT 20
      `;

      const result = await db.query(leaderboardQuery, [year, week]);

      this.sendToClient(ws, {
        type: 'global_leaderboard',
        data: {
          leaderboard: result.rows.map(row => ({
            ...row,
            rank: parseInt(row.rank)
          })),
          week_info: {
            year: parseInt(year),
            week: parseInt(week)
          }
        }
      });

    } catch (error) {
      console.error('Error sending current leaderboard:', error);
    }
  }

  /**
   * Send group leaderboard to all group members
   */
  async sendGroupLeaderboard(groupId) {
    try {
      if (!this.groupClients.has(groupId)) {
        return;
      }

      // Get current week info
      const currentWeekQuery = `
        SELECT 
          EXTRACT(YEAR FROM date_trunc('week', CURRENT_DATE)) as year,
          EXTRACT(WEEK FROM date_trunc('week', CURRENT_DATE)) as week
      `;
      
      const weekResult = await db.query(currentWeekQuery);
      const { year, week } = weekResult.rows[0];

      // Get group leaderboard for current week
      const leaderboardQuery = `
        SELECT 
          u.id,
          u.username,
          COALESCE(ws.score, 0) as score,
          COALESCE(ws.total_locked_minutes, 0) as total_locked_minutes,
          COALESCE(ws.sessions_count, 0) as sessions_count,
          gm.role,
          ROW_NUMBER() OVER (ORDER BY COALESCE(ws.score, 0) DESC, COALESCE(ws.total_locked_minutes, 0) DESC) as rank
        FROM group_members gm
        JOIN users u ON gm.user_id = u.id
        LEFT JOIN weekly_scores ws ON u.id = ws.user_id AND ws.year = $2 AND ws.week = $3
        WHERE gm.group_id = $1
        ORDER BY COALESCE(ws.score, 0) DESC, COALESCE(ws.total_locked_minutes, 0) DESC
      `;

      const result = await db.query(leaderboardQuery, [groupId, year, week]);

      const message = {
        type: 'group_leaderboard',
        groupId: groupId,
        data: {
          leaderboard: result.rows.map(row => ({
            ...row,
            rank: parseInt(row.rank)
          })),
          week_info: {
            year: parseInt(year),
            week: parseInt(week)
          }
        }
      };

      // Send to all group members
      const connections = this.groupClients.get(groupId);
      for (const connection of connections) {
        this.sendToClient(connection.ws, message);
      }

    } catch (error) {
      console.error('Error sending group leaderboard:', error);
    }
  }

  /**
   * Broadcast score update to relevant clients
   */
  async broadcastScoreUpdate(userId) {
    try {
      // Update global leaderboard for all connected clients
      await this.broadcastGlobalLeaderboard();

      // Update group leaderboards for groups the user is in
      const userGroupsQuery = `
        SELECT group_id FROM group_members WHERE user_id = $1
      `;

      const groupsResult = await db.query(userGroupsQuery, [userId]);

      for (const { group_id } of groupsResult.rows) {
        await this.sendGroupLeaderboard(group_id);
      }

    } catch (error) {
      console.error('Error broadcasting score update:', error);
    }
  }

  /**
   * Broadcast global leaderboard to all connected clients
   */
  async broadcastGlobalLeaderboard() {
    try {
      // Get current week info
      const currentWeekQuery = `
        SELECT 
          EXTRACT(YEAR FROM date_trunc('week', CURRENT_DATE)) as year,
          EXTRACT(WEEK FROM date_trunc('week', CURRENT_DATE)) as week
      `;
      
      const weekResult = await db.query(currentWeekQuery);
      const { year, week } = weekResult.rows[0];

      // Get top 20 users for current week
      const leaderboardQuery = `
        SELECT 
          u.id,
          u.username,
          ws.score,
          ws.total_locked_minutes,
          ws.sessions_count,
          ROW_NUMBER() OVER (ORDER BY ws.score DESC, ws.total_locked_minutes DESC) as rank
        FROM weekly_scores ws
        JOIN users u ON ws.user_id = u.id
        WHERE ws.year = $1 AND ws.week = $2
        ORDER BY ws.score DESC, ws.total_locked_minutes DESC
        LIMIT 20
      `;

      const result = await db.query(leaderboardQuery, [year, week]);

      const message = {
        type: 'global_leaderboard',
        data: {
          leaderboard: result.rows.map(row => ({
            ...row,
            rank: parseInt(row.rank)
          })),
          week_info: {
            year: parseInt(year),
            week: parseInt(week)
          }
        }
      };

      // Send to all connected clients
      for (const connections of this.clients.values()) {
        for (const ws of connections) {
          this.sendToClient(ws, message);
        }
      }

    } catch (error) {
      console.error('Error broadcasting global leaderboard:', error);
    }
  }

  /**
   * Send message to a specific client
   */
  sendToClient(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Get connection statistics
   */
  getStats() {
    let totalConnections = 0;
    for (const connections of this.clients.values()) {
      totalConnections += connections.size;
    }

    let totalGroupConnections = 0;
    for (const connections of this.groupClients.values()) {
      totalGroupConnections += connections.size;
    }

    return {
      totalUsers: this.clients.size,
      totalConnections,
      activeGroups: this.groupClients.size,
      totalGroupConnections
    };
  }

  /**
   * Close all connections and cleanup
   */
  close() {
    for (const connections of this.clients.values()) {
      for (const ws of connections) {
        ws.close();
      }
    }

    this.clients.clear();
    this.groupClients.clear();
    this.wss.close();
    
    console.log('WebSocket server closed');
  }
}

module.exports = WebSocketServer;
