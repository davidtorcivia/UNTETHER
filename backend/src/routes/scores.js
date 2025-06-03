const express = require('express');
const { db } = require('../database/connection');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const Joi = require('joi');

const router = express.Router();

// Validation schemas
const getHistorySchema = Joi.object({
  weeks: Joi.number().integer().min(1).max(52).optional().default(10),
  offset: Joi.number().integer().min(0).optional().default(0)
});

// Get current week score
router.get('/current', authenticate, async (req, res, next) => {
  try {
    // Get the current week (Monday to Sunday)
    const currentWeekQuery = `
      SELECT 
        EXTRACT(YEAR FROM date_trunc('week', CURRENT_DATE)) as year,
        EXTRACT(WEEK FROM date_trunc('week', CURRENT_DATE)) as week,
        date_trunc('week', CURRENT_DATE) as week_start,
        date_trunc('week', CURRENT_DATE) + INTERVAL '6 days' as week_end
    `;
    
    const weekResult = await db.query(currentWeekQuery);
    const { year, week, week_start, week_end } = weekResult.rows[0];

    // Get user's current week score
    const scoreQuery = `
      SELECT 
        ws.score,
        ws.total_locked_minutes,
        ws.sessions_count,
        ws.updated_at,
        u.username
      FROM weekly_scores ws
      JOIN users u ON ws.user_id = u.id
      WHERE ws.user_id = $1 AND ws.year = $2 AND ws.week = $3
    `;

    const scoreResult = await db.query(scoreQuery, [req.user.id, year, week]);

    let currentScore = {
      score: 0,
      total_locked_minutes: 0,
      sessions_count: 0,
      year: parseInt(year),
      week: parseInt(week),
      week_start,
      week_end,
      updated_at: null
    };

    if (scoreResult.rows.length > 0) {
      currentScore = {
        ...currentScore,
        ...scoreResult.rows[0],
        year: parseInt(year),
        week: parseInt(week)
      };
    }

    // Get today's events for real-time calculation
    const todayEventsQuery = `
      SELECT 
        locked_at,
        unlocked_at,
        duration_minutes
      FROM screen_events 
      WHERE user_id = $1 
        AND DATE(locked_at) = CURRENT_DATE
        AND unlocked_at IS NOT NULL
      ORDER BY locked_at ASC
    `;

    const todayEvents = await db.query(todayEventsQuery, [req.user.id]);

    // Calculate today's additional score (not yet in weekly_scores)
    const scoringService = require('../services/scoring');
    let todayScore = 0;
    let todayMinutes = 0;

    for (const event of todayEvents.rows) {
      const sessionScore = scoringService.calculateSessionScore(event.duration_minutes);
      todayScore += sessionScore;
      todayMinutes += event.duration_minutes;
    }

    res.json({
      current_week: {
        ...currentScore,
        today_additional_score: todayScore,
        today_additional_minutes: todayMinutes,
        total_score_with_today: currentScore.score + todayScore,
        total_minutes_with_today: currentScore.total_locked_minutes + todayMinutes
      }
    });
  } catch (error) {
    next(error);
  }
});

// Get score history
router.get('/history', authenticate, validate(getHistorySchema, 'query'), async (req, res, next) => {
  try {
    const { weeks, offset } = req.query;

    const historyQuery = `
      SELECT 
        ws.year,
        ws.week,
        ws.score,
        ws.total_locked_minutes,
        ws.sessions_count,
        ws.updated_at,
        date_trunc('week', make_date(ws.year, 1, 1) + (ws.week - 1) * INTERVAL '1 week') as week_start,
        date_trunc('week', make_date(ws.year, 1, 1) + (ws.week - 1) * INTERVAL '1 week') + INTERVAL '6 days' as week_end
      FROM weekly_scores ws
      WHERE ws.user_id = $1
      ORDER BY ws.year DESC, ws.week DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await db.query(historyQuery, [req.user.id, weeks, offset]);

    // Calculate total stats
    const totalStatsQuery = `
      SELECT 
        COUNT(*) as total_weeks,
        COALESCE(SUM(score), 0) as total_score,
        COALESCE(SUM(total_locked_minutes), 0) as total_minutes,
        COALESCE(SUM(sessions_count), 0) as total_sessions,
        COALESCE(AVG(score), 0) as average_weekly_score
      FROM weekly_scores
      WHERE user_id = $1
    `;

    const statsResult = await db.query(totalStatsQuery, [req.user.id]);
    const stats = statsResult.rows[0];

    res.json({
      history: result.rows,
      pagination: {
        weeks: parseInt(weeks),
        offset: parseInt(offset),
        has_more: result.rows.length === weeks
      },
      total_stats: {
        total_weeks: parseInt(stats.total_weeks),
        total_score: parseFloat(stats.total_score),
        total_minutes: parseInt(stats.total_minutes),
        total_sessions: parseInt(stats.total_sessions),
        average_weekly_score: parseFloat(stats.average_weekly_score)
      }
    });
  } catch (error) {
    next(error);
  }
});

// Get leaderboard (global)
router.get('/leaderboard', authenticate, async (req, res, next) => {
  try {
    // Get current week info
    const currentWeekQuery = `
      SELECT 
        EXTRACT(YEAR FROM date_trunc('week', CURRENT_DATE)) as year,
        EXTRACT(WEEK FROM date_trunc('week', CURRENT_DATE)) as week
    `;
    
    const weekResult = await db.query(currentWeekQuery);
    const { year, week } = weekResult.rows[0];

    // Get top 50 users for current week
    const leaderboardQuery = `
      SELECT 
        u.id,
        u.username,
        ws.score,
        ws.total_locked_minutes,
        ws.sessions_count,
        ws.updated_at,
        ROW_NUMBER() OVER (ORDER BY ws.score DESC, ws.total_locked_minutes DESC) as rank
      FROM weekly_scores ws
      JOIN users u ON ws.user_id = u.id
      WHERE ws.year = $1 AND ws.week = $2
      ORDER BY ws.score DESC, ws.total_locked_minutes DESC
      LIMIT 50
    `;

    const leaderboard = await db.query(leaderboardQuery, [year, week]);

    // Get current user's rank and position
    const userRankQuery = `
      WITH ranked_users AS (
        SELECT 
          user_id,
          score,
          ROW_NUMBER() OVER (ORDER BY score DESC, total_locked_minutes DESC) as rank
        FROM weekly_scores
        WHERE year = $1 AND week = $2
      )
      SELECT rank FROM ranked_users WHERE user_id = $3
    `;

    const userRankResult = await db.query(userRankQuery, [year, week, req.user.id]);
    const userRank = userRankResult.rows[0]?.rank || null;

    res.json({
      leaderboard: leaderboard.rows,
      current_user_rank: userRank ? parseInt(userRank) : null,
      week_info: {
        year: parseInt(year),
        week: parseInt(week)
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
