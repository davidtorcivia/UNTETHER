const express = require('express');
const { db } = require('../database/connection');
const { authenticate } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validation'); // Updated import
const { AppError } = require('../middleware/errorHandler'); // For throwing errors

const router = express.Router();

// Create a new group
router.post('/create', authenticate, validate(schemas.createGroup), async (req, res, next) => {
  try {
    const { name, description, type } = req.body; // Changed from is_private to type

    // Check if user already owns a group (limit to 1 group per user as owner)
    const existingGroup = await db.query(
      'SELECT id FROM groups WHERE owner_id = $1',
      [req.user.id]
    );

    if (existingGroup.rows.length > 0) {
      throw new AppError('You can only own one group at a time', 409, 'E020');
    }

    // Check if group name is taken
    const nameExists = await db.query(
      'SELECT id FROM groups WHERE LOWER(name) = LOWER($1)',
      [name]
    );

    if (nameExists.rows.length > 0) {
      throw new AppError('Group name already taken', 409, 'E021');
    }

    const client = await db.connect();
    
    try {
      await client.query('BEGIN');

      // Create the group
      const groupResult = await client.query( // Using 'type' column from DB schema
        `INSERT INTO groups (name, description, owner_id, type, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING id, name, description, owner_id, type, created_at`,
        [name, description, req.user.id, type]
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
router.post('/join', authenticate, validate(schemas.joinGroup), async (req, res, next) => {
  try {
    const { groupId, inviteCode } = req.body; // Changed from group_id, expecting UUID

    if (!groupId && !inviteCode) { // Should be caught by Joi's .or()
        throw new AppError('Either groupId or inviteCode must be provided', 400, 'E400');
    }

    let groupToJoin;

    // Check if group exists and is not private
    if (groupId) {
        const groupResult = await db.query('SELECT id, name, type FROM groups WHERE id = $1', [groupId]);
        if (groupResult.rows.length === 0) throw new AppError('Group not found', 404, 'E022');
        groupToJoin = groupResult.rows[0];
    } else { // inviteCode must be present due to Joi .or()
        const groupResult = await db.query('SELECT id, name, type FROM groups WHERE invite_code = $1', [inviteCode]);
        if (groupResult.rows.length === 0) throw new AppError('Invalid invite code or group not found', 404, 'E022');
        groupToJoin = groupResult.rows[0];
    }


    if (groupToJoin.type === 'PRIVATE' && !groupId) { // Can only join private by direct ID if some other mechanism allows, otherwise needs invite
      throw new AppError('Cannot join private group without a valid invite code or direct access', 403, 'E023');
    }

    // Check if user is already a member
    const existingMember = await db.query(
      'SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupToJoin.id, req.user.id]
    );

    if (existingMember.rows.length > 0) {
      throw new AppError('Already a member of this group', 409, 'E024');
    }

    // Check group size limit (max 50 members)
    const memberCount = await db.query(
      'SELECT COUNT(*) as count FROM group_members WHERE group_id = $1',
      [groupToJoin.id]
    );

    if (parseInt(memberCount.rows[0].count) >= 50) {
      throw new AppError('Group is full (maximum 50 members)', 409, 'E025');
    }

    // Add user to group
    await db.query(
      `INSERT INTO group_members (group_id, user_id, role, joined_at)
       VALUES ($1, $2, 'member', NOW())`,
      [groupToJoin.id, req.user.id]
    );

    res.json({
      message: 'Successfully joined group',
      group: {
        id: groupToJoin.id,
        name: groupToJoin.name
      }
    });

  } catch (error) {
    next(error);
  }
});

// Leave a group
router.post('/leave/:groupId', authenticate, validate(schemas.groupIdParam, 'params'), async (req, res, next) => {
  try {
    const { groupId } = req.params; // groupId is now a validated UUID string

    // Check if user is a member
    const memberResult = await db.query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, req.user.id] // No parseInt needed
    );

    if (memberResult.rows.length === 0) {
      throw new AppError('Not a member of this group', 404, 'E026');
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
router.get('/search', authenticate, validate(schemas.searchGroupsSchema, 'query'), async (req, res, next) => {
  try {
    const { q, limit } = req.query; // q and limit are validated
    
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
      WHERE g.type = 'PUBLIC'
    `;

    const params = [req.user.id];

    if (q) {
      searchQuery += ` AND (g.name ILIKE $${params.length + 1} OR g.description ILIKE $${params.length + 1})`;
      params.push(`%${q}%`);
    }

    searchQuery += `
      GROUP BY g.id, g.name, g.description, g.created_at, u.username
      ORDER BY member_count DESC, g.created_at DESC
      LIMIT $${params.length + 1}
    `;
    params.push(limit); // Add limit to params array

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
router.get('/:groupId/leaderboard', authenticate, validate(schemas.groupIdParam, 'params'), async (req, res, next) => {
  try {
    const { groupId } = req.params; // groupId is validated UUID

    // Verify user is a member of the group
    const memberCheck = await db.query(
      'SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, req.user.id] // No parseInt
    );

    if (memberCheck.rows.length === 0) {
      throw new AppError('Access denied - not a member of this group', 403, 'E027');
    }

    // Get current week_start date based on user's timezone from req.user (if available) or default to UTC
    // For simplicity, using server's current week, which aligns with how scores are generally processed by scoringService.
    const userTimezone = req.user.timezone || 'UTC';
    const currentWeekStart = require('luxon').DateTime.now().setZone(userTimezone).startOf('week').toISODate();

    // Get group leaderboard for current week
    const leaderboardQuery = `
      SELECT 
        u.id,
        u.username,
        COALESCE(ws.total_score, 0) as score, -- Changed ws.score to ws.total_score
        -- COALESCE(ws.total_locked_minutes, 0) as total_locked_minutes, -- Column does not exist in weekly_scores
        -- COALESCE(ws.sessions_count, 0) as sessions_count, -- Column does not exist
        ws.last_updated, -- Changed from ws.updated_at
        gm.role,
        ROW_NUMBER() OVER (ORDER BY COALESCE(ws.total_score, 0) DESC) as rank -- Removed non-existent columns from ORDER BY
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      LEFT JOIN weekly_scores ws ON u.id = ws.user_id AND ws.week_start = $2 -- Query by week_start
      WHERE gm.group_id = $1
      ORDER BY rank ASC
    `;

    const leaderboard = await db.query(leaderboardQuery, [groupId, currentWeekStart]);

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
      week_start: currentWeekStart
    });

  } catch (error) {
    next(error);
  }
});

// Update group (owner only)
router.put('/:groupId', authenticate, [validate(schemas.groupIdParam, 'params'), validate(schemas.updateGroup)], async (req, res, next) => {
  try {
    const { groupId } = req.params; // Validated UUID
    const { name, description, type } = req.body; // Changed is_private to type

    // Verify user is the owner
    const ownerCheck = await db.query(
      'SELECT id FROM groups WHERE id = $1 AND owner_id = $2',
      [groupId, req.user.id] // No parseInt
    );

    if (ownerCheck.rows.length === 0) {
      throw new AppError('Access denied - only group owner can update group', 403, 'E028');
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
        throw new AppError('Group name already taken', 409, 'E021');
      }

      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }

    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }

    if (type !== undefined) { // Changed from is_private
      updates.push(`type = $${paramIndex++}`); // Use 'type' column
      values.push(type);
    }

    if (updates.length === 0) {
      throw new AppError('No valid fields to update', 400, 'E008');
    }

    updates.push(`updated_at = NOW()`);
    values.push(groupId);

    const queryText = `
      UPDATE groups 
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, name, description, type, updated_at
    `;

    const result = await db.query(queryText, values);

    res.json({
      message: 'Group updated successfully',
      group: result.rows[0]
    });

  } catch (error) {
    next(error);
  }
});

// Manage group members (owner only)
router.post('/:groupId/members', authenticate, [validate(schemas.groupIdParam, 'params'), validate(schemas.manageMember)], async (req, res, next) => {
  try {
    const { groupId } = req.params; // Validated UUID
    const { userId, action } = req.body; // userId is validated UUID

    // Verify user is the owner
    const ownerCheck = await db.query(
      'SELECT id FROM groups WHERE id = $1 AND owner_id = $2',
      [groupId, req.user.id] // No parseInt
    );

    if (ownerCheck.rows.length === 0) {
      throw new AppError('Access denied - only group owner can manage members', 403, 'E029');
    }

    // Cannot manage yourself
    if (userId === req.user.id) {
      throw new AppError('Cannot manage your own membership', 400, 'E030');
    }

    // Check if target user is a member
    const memberCheck = await db.query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, userId] // No parseInt
    );

    if (memberCheck.rows.length === 0) {
      throw new AppError('User is not a member of this group', 404, 'E031');
    }

    const currentRole = memberCheck.rows[0].role;

    switch (action) {
      case 'remove':
        await db.query(
          'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2',
          [groupId, userId]
        );
        break;

      case 'promote':
        if (currentRole === 'member') {
          await db.query(
            'UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3',
            ['admin', groupId, userId]
          );
        }
        break;

      case 'demote':
        if (currentRole === 'admin') {
          await db.query(
            'UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3',
            ['member', groupId, userId]
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
