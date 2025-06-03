const { db } = require('../database/connection');
const scoringService = require('./scoring');

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

      // Get the week that just ended
      const weekQuery = `
        SELECT 
          EXTRACT(YEAR FROM date_trunc('week', CURRENT_DATE - INTERVAL '1 week')) as year,
          EXTRACT(WEEK FROM date_trunc('week', CURRENT_DATE - INTERVAL '1 week')) as week,
          date_trunc('week', CURRENT_DATE - INTERVAL '1 week') as week_start,
          date_trunc('week', CURRENT_DATE - INTERVAL '1 week') + INTERVAL '6 days' + INTERVAL '23:59:59' as week_end
      `;

      const weekResult = await client.query(weekQuery);
      const { year, week, week_start, week_end } = weekResult.rows[0];

      console.log(`Processing week ${week} of year ${year} (${week_start} to ${week_end})`);

      // Get all users who had screen events in the past week
      const usersQuery = `
        SELECT DISTINCT user_id 
        FROM screen_events 
        WHERE locked_at >= $1 AND locked_at <= $2
      `;

      const usersResult = await client.query(usersQuery, [week_start, week_end]);
      console.log(`Found ${usersResult.rows.length} users with events in the past week`);

      let processedUsers = 0;
      let totalScore = 0;

      for (const { user_id } of usersResult.rows) {
        try {
          const userScore = await this.processUserWeeklyScore(client, user_id, year, week, week_start, week_end);
          totalScore += userScore.score;
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
      console.log(`- Total points awarded: ${totalScore}`);
      console.log(`- Week: ${week}/${year}`);

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
  async processUserWeeklyScore(client, userId, year, week, weekStart, weekEnd) {
    // Check if this user's week has already been processed
    const existingScore = await client.query(
      'SELECT id, score FROM weekly_scores WHERE user_id = $1 AND year = $2 AND week = $3',
      [userId, year, week]
    );

    if (existingScore.rows.length > 0) {
      console.log(`User ${userId} week ${week}/${year} already processed, skipping`);
      return existingScore.rows[0];
    }

    // Get all completed screen events for this user in the week
    const eventsQuery = `
      SELECT 
        id,
        locked_at,
        unlocked_at,
        duration_minutes,
        is_valid
      FROM screen_events 
      WHERE user_id = $1 
        AND locked_at >= $2 
        AND locked_at <= $3
        AND unlocked_at IS NOT NULL
        AND is_valid = true
      ORDER BY locked_at ASC
    `;

    const eventsResult = await client.query(eventsQuery, [userId, weekStart, weekEnd]);
    const events = eventsResult.rows;

    let totalScore = 0;
    let totalMinutes = 0;
    let sessionsCount = events.length;

    // Calculate score for each session
    for (const event of events) {
      const sessionScore = scoringService.calculateSessionScore(event.duration_minutes);
      totalScore += sessionScore;
      totalMinutes += event.duration_minutes;
    }

    // Insert the weekly score
    const insertResult = await client.query(
      `INSERT INTO weekly_scores 
       (user_id, year, week, score, total_locked_minutes, sessions_count, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id, score`,
      [userId, year, week, totalScore, totalMinutes, sessionsCount]
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

      // Calculate cutoff date (12 weeks ago)
      const cutoffQuery = `
        SELECT 
          date_trunc('week', CURRENT_DATE - INTERVAL '12 weeks') as cutoff_date,
          EXTRACT(YEAR FROM date_trunc('week', CURRENT_DATE - INTERVAL '12 weeks')) as cutoff_year,
          EXTRACT(WEEK FROM date_trunc('week', CURRENT_DATE - INTERVAL '12 weeks')) as cutoff_week
      `;

      const cutoffResult = await client.query(cutoffQuery);
      const { cutoff_date, cutoff_year, cutoff_week } = cutoffResult.rows[0];

      console.log(`Cleaning up data older than ${cutoff_date} (week ${cutoff_week}/${cutoff_year})`);

      // Delete old screen events
      const eventsDeleted = await client.query(
        'DELETE FROM screen_events WHERE locked_at < $1',
        [cutoff_date]
      );

      // Delete old weekly scores
      const scoresDeleted = await client.query(
        `DELETE FROM weekly_scores 
         WHERE (year < $1) OR (year = $1 AND week < $2)`,
        [cutoff_year, cutoff_week]
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
