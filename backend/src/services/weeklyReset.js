const { db } = require('../database/connection');
const scoringService = require('./scoring');
const { DateTime } = require('luxon'); // For date manipulations if needed for week_start

class WeeklyResetService {
  constructor() {
    this.isRunning = false;
  }

  /**
   * Process weekly scores for all users
   * This should be run at the end of each week (Sunday night)
   */
  async processWeeklyScores() {
    if (this.isRunning) {
      console.log('Weekly reset already in progress, skipping...');
      return;
    }

    this.isRunning = true;
    console.log('Starting weekly score processing...');

    const client = await db.connect();
    
    try {
      await client.query('BEGIN');

      // Get the week_start (e.g., Monday) for the week that just ended.
      // Luxon's week starts on Monday. PostgreSQL's date_trunc('week', ...) also defaults to Monday.
      const processingWeekStart = DateTime.now().minus({ weeks: 1 }).startOf('week').toISODate();
      const processingWeekEnd = DateTime.now().minus({ weeks: 1 }).endOf('week').toISODate(); // End of Sunday

      console.log(`Processing week starting ${processingWeekStart} (ends ${processingWeekEnd})`);

      // Get all users who had screen events in the past week
      const usersQuery = `
        SELECT DISTINCT user_id 
        FROM screen_events 
        WHERE timestamp >= $1 AND timestamp <= $2
      `;
      // Use week_start (inclusive) and week_end (inclusive for the full day)
      const usersResult = await client.query(usersQuery, [processingWeekStart, DateTime.fromISO(processingWeekEnd).plus({days:1}).toISODate()]);
      console.log(`Found ${usersResult.rows.length} users with events in the past week`);

      let processedUsers = 0;
      let totalScore = 0;
      let totalSessions = 0;

      for (const { user_id } of usersResult.rows) {
        try {
          const weeklyData = await this.processUserWeeklyScore(client, user_id, processingWeekStart);
          totalScore += weeklyData.total_score || 0;
          totalSessions += weeklyData.sessions_count || 0;
          processedUsers++;

          if (processedUsers % 100 === 0) {
            console.log(`Processed ${processedUsers}/${usersResult.rows.length} users`);
          }
        } catch (error) {
          console.error(`Error processing user ${user_id}:`, error);
          // Continue processing other users
        }
      }

      await client.query('COMMIT');

      console.log(`Weekly reset completed successfully:`);
      console.log(`- Processed ${processedUsers} users`);
      console.log(`- Total score processed: ${totalScore}`);
      console.log(`- Total sessions processed: ${totalSessions}`);
      console.log(`- Week starting: ${processingWeekStart}`);

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error during weekly reset:', error);
      throw error;
    } finally {
      client.release();
      this.isRunning = false;
    }
  }

  /**
   * Process weekly score for a single user
   */
  async processUserWeeklyScore(client, userId, weekStartDate) {
    // Check if this user's week has already been processed
    const existingScore = await client.query(
      'SELECT id, total_score FROM weekly_scores WHERE user_id = $1 AND week_start = $2',
      [userId, weekStartDate]
    );

    if (existingScore.rows.length > 0) {
      console.log(`User ${userId} for week ${weekStartDate} already processed, skipping. Score: ${existingScore.rows[0].total_score}`);
      return {
        total_score: existingScore.rows[0].total_score,
        sessions_count: 0 // Or fetch if we stored sessions_count, init.sql doesn't have it
      };
    }

    const weekEndDate = DateTime.fromISO(weekStartDate).plus({ days: 6 }).endOf('day').toISO();

    // Get all screen events for this user in the week (processed or not, to ensure all data is captured)
    const eventsQuery = `
      SELECT 
        user_id,
        device_uuid,
        event_type,
        timestamp
      FROM screen_events 
      WHERE user_id = $1 
        AND timestamp >= $2
        AND timestamp <= $3
      ORDER BY timestamp ASC
    `;

    const eventsResult = await client.query(eventsQuery, [userId, weekStartDate, weekEndDate]);
    const events = eventsResult.rows;

    if (events.length === 0) {
      return { total_score: 0, sessions_count: 0 };
    }

    const sessions = scoringService.extractSessions(events);
    let totalScore = 0;
    for (const session of sessions) {
      totalScore += session.score;
    }

    // Insert the weekly score
    const insertResult = await client.query(
      `INSERT INTO weekly_scores 
       (user_id, week_start, total_score, last_updated)
       VALUES ($1, $2, $3, NOW())
       RETURNING id, total_score`,
      [userId, weekStartDate, totalScore]
    );

    return insertResult.rows[0];
  }

  /**
   * Cleanup old screen events and weekly scores
   * Keep last 12 weeks of data, remove older data
   */
  async cleanupOldData() {
    console.log('Starting cleanup of old data...');

    const client = await db.connect();
    
    try {
      await client.query('BEGIN');

      // Calculate cutoff date (12 weeks ago from the start of the current week)
      const cutoffDate = DateTime.now().startOf('week').minus({ weeks: 12 }).toISODate();

      console.log(`Cleaning up data older than ${cutoffDate}`);

      // Delete old screen events
      const eventsDeleted = await client.query(
        'DELETE FROM screen_events WHERE timestamp < $1',
        [cutoffDate]
      );

      // Delete old weekly scores
      const scoresDeleted = await client.query(
        `DELETE FROM weekly_scores WHERE week_start < $1`,
        [cutoffDate]
      );

      // Delete old refresh tokens (older than 30 days)
      const tokensDeleted = await client.query(
        'DELETE FROM refresh_tokens WHERE created_at < NOW() - INTERVAL \'30 days\''
      );

      await client.query('COMMIT');

      console.log('Cleanup completed:');
      console.log(`- Deleted ${eventsDeleted.rowCount} old screen events`);
      console.log(`- Deleted ${scoresDeleted.rowCount} old weekly scores`);
      console.log(`- Deleted ${tokensDeleted.rowCount} old refresh tokens`);

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error during cleanup:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Reprocess a specific week for all users (admin function)
   */
  async reprocessWeek(targetYear, targetWeek) {
    console.log(`Reprocessing week ${targetWeek}/${targetYear}...`);

    const client = await db.connect();
    
    try {
      await client.query('BEGIN');

      // Calculate week boundaries
      const weekBoundariesQuery = `
        SELECT 
          date_trunc('week', make_date($1, 1, 1) + (($2 - 1) * INTERVAL '1 week')) as week_start,
          date_trunc('week', make_date($1, 1, 1) + (($2 - 1) * INTERVAL '1 week')) + INTERVAL '6 days' + INTERVAL '23:59:59' as week_end
      `;

      const boundariesResult = await client.query(weekBoundariesQuery, [targetYear, targetWeek]);
      const { week_start, week_end } = boundariesResult.rows[0];

      // Delete existing weekly scores for this week
      await client.query(
        'DELETE FROM weekly_scores WHERE year = $1 AND week = $2',
        [targetYear, targetWeek]
      );

      // Get all users who had events in this week
      const usersQuery = `
        SELECT DISTINCT user_id 
        FROM screen_events 
        WHERE locked_at >= $1 AND locked_at <= $2
      `;

      const usersResult = await client.query(usersQuery, [week_start, week_end]);

      let processedUsers = 0;
      for (const { user_id } of usersResult.rows) {
        await this.processUserWeeklyScore(client, user_id, targetYear, targetWeek, week_start, week_end);
        processedUsers++;
      }

      await client.query('COMMIT');

      console.log(`Reprocessed week ${targetWeek}/${targetYear}: ${processedUsers} users`);
      return { processedUsers, week: targetWeek, year: targetYear };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Error reprocessing week ${targetWeek}/${targetYear}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Start the weekly reset scheduler
   * Runs every Sunday at 23:59 UTC
   */
  startScheduler() {
    const cron = require('node-cron');

    // Run every Sunday at 23:59 UTC
    cron.schedule('59 23 * * 0', async () => {
      try {
        console.log('Scheduled weekly reset triggered');
        await this.processWeeklyScores();
      } catch (error) {
        console.error('Scheduled weekly reset failed:', error);
      }
    }, {
      timezone: 'UTC'
    });

    // Run cleanup every Monday at 01:00 UTC
    cron.schedule('0 1 * * 1', async () => {
      try {
        console.log('Scheduled cleanup triggered');
        await this.cleanupOldData();
      } catch (error) {
        console.error('Scheduled cleanup failed:', error);
      }
    }, {
      timezone: 'UTC'
    });

    console.log('Weekly reset scheduler started');
    console.log('- Weekly processing: Sundays at 23:59 UTC');
    console.log('- Data cleanup: Mondays at 01:00 UTC');
  }
}

module.exports = new WeeklyResetService();
