const express = require('express');
const { db } = require('../database/connection');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const Joi = require('joi');

const router = express.Router();

// Validation schemas
const createGroupSchema = Joi.object({
  name: Joi.string().min(3).max(50).required(),
  description: Joi.string().max(255).optional(),
  is_private: Joi.boolean().optional().default(false)
});

const joinGroupSchema = Joi.object({
  group_id: Joi.number().integer().positive().required()
});

const updateGroupSchema = Joi.object({
  name: Joi.string().min(3).max(50).optional(),
  description: Joi.string().max(255).optional(),
  is_private: Joi.boolean().optional()
});

const manageMemberSchema = Joi.object({
  user_id: Joi.number().integer().positive().required(),
  action: Joi.string().valid('remove', 'promote', 'demote').required()
});

// Create a new group
router.post('/create', authenticate, validate(createGroupSchema), async (req, res, next) => {
  try {
    const { name, description, is_private } = req.body;

    // Check if user already owns a group (limit to 1 group per user as owner)
    const existingGroup = await db.query(
      'SELECT id FROM groups WHERE owner_id = $1',
      [req.user.id]
    );

    if (existingGroup.rows.length > 0) {
      return res.status(409).json({
        error: 'You can only own one group at a time',
        code: 'E020'
      });
    }

    // Check if group name is taken
    const nameExists = await db.query(
      'SELECT id FROM groups WHERE LOWER(name) = LOWER($1)',
      [name]
    );

    if (nameExists.rows.length > 0) {
      return res.status(409).json({
        error: 'Group name already taken',
        code: 'E021'
      });
    }

    const client = await db.connect();
    
    try {
      await client.query('BEGIN');

      // Create the group
      const groupResult = await client.query(
        `INSERT INTO groups (name, description, owner_id, is_private, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING id, name, description, owner_id, is_private, created_at`,
        [name, description, req.user.id, is_private]
      );

      const group = groupResult.rows[0];

      // Add owner as first member
      await client.query(
        `INSERT INTO group_members (group_id, user_id, role, joined_at)
         VALUES ($1, $2, 'owner', NOW())`,
        [group.id, req.user.id]
      );

      await client.query('COMMIT');

      res.status(201).json({
        message: 'Group created successfully',
        group
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    next(error);
  }
});

// Join a group
router.post('/join', authenticate, validate(joinGroupSchema), async (req, res, next) => {
  try {
    const { group_id } = req.body;

    // Check if group exists and is not private
    const groupResult = await db.query(
      'SELECT id, name, is_private FROM groups WHERE id = $1',
      [group_id]
    );

    if (groupResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Group not found',
        code: 'E022'
      });
    }

    const group = groupResult.rows[0];

    if (group.is_private) {
      return res.status(403).json({
        error: 'Cannot join private group without invitation',
        code: 'E023'
      });
    }

    // Check if user is already a member
    const existingMember = await db.query(
      'SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2',
      [group_id, req.user.id]
    );

    if (existingMember.rows.length > 0) {
      return res.status(409).json({
        error: 'Already a member of this group',
        code: 'E024'
      });
    }

    // Check group size limit (max 50 members)
    const memberCount = await db.query(
      'SELECT COUNT(*) as count FROM group_members WHERE group_id = $1',
      [group_id]
    );

    if (parseInt(memberCount.rows[0].count) >= 50) {
      return res.status(409).json({
        error: 'Group is full (maximum 50 members)',
        code: 'E025'
      });
    }

    // Add user to group
    await db.query(
      `INSERT INTO group_members (group_id, user_id, role, joined_at)
       VALUES ($1, $2, 'member', NOW())`,
      [group_id, req.user.id]
    );

    res.json({
      message: 'Successfully joined group',
      group: {
        id: group.id,
        name: group.name
      }
    });

  } catch (error) {
    next(error);
  }
});

// Leave a group
router.post('/leave/:groupId', authenticate, async (req, res, next) => {
  try {
    const groupId = parseInt(req.params.groupId);

    // Check if user is a member
    const memberResult = await db.query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, req.user.id]
    );

    if (memberResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Not a member of this group',
        code: 'E026'
      });
    }

    const { role } = memberResult.rows[0];

    // If owner is leaving, need to transfer ownership or delete group
    if (role === 'owner') {
      // Check if there are other members
      const otherMembers = await db.query(
        `SELECT user_id FROM group_members 
         WHERE group_id = $1 AND user_id != $2 AND role != 'owner'
         ORDER BY joined_at ASC
         LIMIT 1`,
        [groupId, req.user.id]
      );

      const client = await db.connect();
      
      try {
        await client.query('BEGIN');

        if (otherMembers.rows.length > 0) {
          // Transfer ownership to oldest member
          const newOwnerId = otherMembers.rows[0].user_id;
          
          await client.query(
            'UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3',
            ['owner', groupId, newOwnerId]
          );

          await client.query(
            'UPDATE groups SET owner_id = $1 WHERE id = $2',
            [newOwnerId, groupId]
          );

          // Remove original owner
          await client.query(
            'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2',
            [groupId, req.user.id]
          );

        } else {
          // No other members, delete the group
          await client.query(
            'DELETE FROM group_members WHERE group_id = $1',
            [groupId]
          );

          await client.query(
            'DELETE FROM groups WHERE id = $1',
            [groupId]
          );
        }

        await client.query('COMMIT');

      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

    } else {
      // Regular member leaving
      await db.query(
        'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2',
        [groupId, req.user.id]
      );
    }

    res.json({
      message: 'Successfully left group'
    });

  } catch (error) {
    next(error);
  }
});

// List user's groups
router.get('/my-groups', authenticate, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT 
        g.id,
        g.name,
        g.description,
        g.is_private,
        g.created_at,
        gm.role,
        gm.joined_at,
        u.username as owner_username,
        COUNT(gm2.user_id) as member_count
       FROM groups g
       JOIN group_members gm ON g.id = gm.group_id
       JOIN users u ON g.owner_id = u.id
       LEFT JOIN group_members gm2 ON g.id = gm2.group_id
       WHERE gm.user_id = $1
       GROUP BY g.id, g.name, g.description, g.is_private, g.created_at, gm.role, gm.joined_at, u.username
       ORDER BY gm.joined_at DESC`,
      [req.user.id]
    );

    res.json({
      groups: result.rows.map(row => ({
        ...row,
        member_count: parseInt(row.member_count)
      }))
    });

  } catch (error) {
    next(error);
  }
});

// Search public groups
router.get('/search', authenticate, async (req, res, next) => {
  try {
    const { query } = req.query;
    
    let searchQuery = `
      SELECT 
        g.id,
        g.name,
        g.description,
        g.created_at,
        u.username as owner_username,
        COUNT(gm.user_id) as member_count,
        EXISTS(
          SELECT 1 FROM group_members gm2 
          WHERE gm2.group_id = g.id AND gm2.user_id = $2
        ) as is_member
      FROM groups g
      JOIN users u ON g.owner_id = u.id
      LEFT JOIN group_members gm ON g.id = gm.group_id
      WHERE g.is_private = false
    `;

    const params = [req.user.id];

    if (query) {
      searchQuery += ` AND (g.name ILIKE $${params.length + 1} OR g.description ILIKE $${params.length + 1})`;
      params.push(`%${query}%`);
    }

    searchQuery += `
      GROUP BY g.id, g.name, g.description, g.created_at, u.username
      ORDER BY member_count DESC, g.created_at DESC
      LIMIT 20
    `;

    const result = await db.query(searchQuery, params);

    res.json({
      groups: result.rows.map(row => ({
        ...row,
        member_count: parseInt(row.member_count),
        is_member: row.is_member
      }))
    });

  } catch (error) {
    next(error);
  }
});

// Get group leaderboard
router.get('/:groupId/leaderboard', authenticate, async (req, res, next) => {
  try {
    const groupId = parseInt(req.params.groupId);

    // Verify user is a member of the group
    const memberCheck = await db.query(
      'SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, req.user.id]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({
        error: 'Access denied - not a member of this group',
        code: 'E027'
      });
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
        ws.updated_at,
        gm.role,
        ROW_NUMBER() OVER (ORDER BY COALESCE(ws.score, 0) DESC, COALESCE(ws.total_locked_minutes, 0) DESC) as rank
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      LEFT JOIN weekly_scores ws ON u.id = ws.user_id AND ws.year = $2 AND ws.week = $3
      WHERE gm.group_id = $1
      ORDER BY COALESCE(ws.score, 0) DESC, COALESCE(ws.total_locked_minutes, 0) DESC
    `;

    const leaderboard = await db.query(leaderboardQuery, [groupId, year, week]);

    // Get group info
    const groupInfo = await db.query(
      'SELECT name, description FROM groups WHERE id = $1',
      [groupId]
    );

    res.json({
      group: groupInfo.rows[0],
      leaderboard: leaderboard.rows.map(row => ({
        ...row,
        rank: parseInt(row.rank)
      })),
      week_info: {
        year: parseInt(year),
        week: parseInt(week)
      }
    });

  } catch (error) {
    next(error);
  }
});

// Update group (owner only)
router.put('/:groupId', authenticate, validate(updateGroupSchema), async (req, res, next) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { name, description, is_private } = req.body;

    // Verify user is the owner
    const ownerCheck = await db.query(
      'SELECT id FROM groups WHERE id = $1 AND owner_id = $2',
      [groupId, req.user.id]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(403).json({
        error: 'Access denied - only group owner can update group',
        code: 'E028'
      });
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name) {
      // Check if new name is taken
      const nameExists = await db.query(
        'SELECT id FROM groups WHERE LOWER(name) = LOWER($1) AND id != $2',
        [name, groupId]
      );

      if (nameExists.rows.length > 0) {
        return res.status(409).json({
          error: 'Group name already taken',
          code: 'E021'
        });
      }

      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }

    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }

    if (is_private !== undefined) {
      updates.push(`is_private = $${paramIndex++}`);
      values.push(is_private);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: 'No valid fields to update',
        code: 'E008'
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(groupId);

    const query = `
      UPDATE groups 
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, name, description, is_private, updated_at
    `;

    const result = await db.query(query, values);

    res.json({
      message: 'Group updated successfully',
      group: result.rows[0]
    });

  } catch (error) {
    next(error);
  }
});

// Manage group members (owner only)
router.post('/:groupId/members', authenticate, validate(manageMemberSchema), async (req, res, next) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { user_id, action } = req.body;

    // Verify user is the owner
    const ownerCheck = await db.query(
      'SELECT id FROM groups WHERE id = $1 AND owner_id = $2',
      [groupId, req.user.id]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(403).json({
        error: 'Access denied - only group owner can manage members',
        code: 'E029'
      });
    }

    // Cannot manage yourself
    if (user_id === req.user.id) {
      return res.status(400).json({
        error: 'Cannot manage your own membership',
        code: 'E030'
      });
    }

    // Check if target user is a member
    const memberCheck = await db.query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, user_id]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(404).json({
        error: 'User is not a member of this group',
        code: 'E031'
      });
    }

    const currentRole = memberCheck.rows[0].role;

    switch (action) {
      case 'remove':
        await db.query(
          'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2',
          [groupId, user_id]
        );
        break;

      case 'promote':
        if (currentRole === 'member') {
          await db.query(
            'UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3',
            ['admin', groupId, user_id]
          );
        }
        break;

      case 'demote':
        if (currentRole === 'admin') {
          await db.query(
            'UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3',
            ['member', groupId, user_id]
          );
        }
        break;
    }

    res.json({
      message: `Member ${action} completed successfully`
    });

  } catch (error) {
    next(error);
  }
});

module.exports = router;
