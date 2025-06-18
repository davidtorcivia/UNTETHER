const express = require('express');
const { query } = require('../database/connection');
const { authenticate } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validation');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const { processEvents, checkAnomalies } = require('../services/scoring');

const router = express.Router();

// Upload batch of screen events
router.post('/batch', authenticate, validate(schemas.batchEvents), asyncHandler(async (req, res) => {
  const { events, deviceCert } = req.body;
  const userId = req.userId;

  if (!events || events.length === 0) {
    throw new AppError('No events provided', 400, 'E400', 'No events in batch.');
  }

  // Ensure all events in the batch share the same device_uuid
  const firstDeviceUUID = events[0].device_uuid;
  if (!firstDeviceUUID) {
    throw new AppError('Missing device_uuid in first event', 400, 'E400', 'Device UUID missing in event data.');
  }
  for (let i = 1; i < events.length; i++) {
    if (events[i].device_uuid !== firstDeviceUUID) {
      throw new AppError('All events in a batch must share the same device_uuid', 400, 'E400', 'Mismatched device_uuid in batch.');
    }
  }

  // Validate event timestamps
  const now = Date.now();
  for (const event of events) {
    const eventTime = new Date(event.timestamp).getTime();
    
    // Events can't be more than 7 days old
    const eventAge = now - eventTime;
    if (eventAge > 7 * 24 * 60 * 60 * 1000) { // 7 days
      throw new AppError('Events too old', 400, 'E400', `Event timestamp ${event.timestamp} is too old.`);
    }
    
    // Events can't be in the future (allow 5 minute tolerance for clock skew)
    if (eventTime > now + (5 * 60 * 1000)) {
      throw new AppError('Future events not allowed', 400, 'E400', `Event timestamp ${event.timestamp} is in the future.`);
    }
  }

  // Check for anomalies
  const anomalyCheck = await checkAnomalies(userId, events);
  if (!anomalyCheck.isValid) {
    console.warn('Anomalies detected for user', userId, ':', anomalyCheck.flags);
    
    // For now, just log the anomalies but still process the events
    // In production, you might want to flag the account or require additional verification
  }

  try {
    // Process events and calculate scores
    const result = await processEvents(events, userId, firstDeviceUUID, deviceCert);

    res.json({
      message: 'Events processed successfully',
      sessionsProcessed: result.sessionsProcessed,
      totalScore: result.totalScore,
      deviceVerified: result.isDeviceVerified,
      anomalies: anomalyCheck.flags.length > 0 ? anomalyCheck.flags : undefined
    });

  } catch (error) {
    if (error.message === 'Invalid event sequence detected') {
      throw new AppError('Invalid event sequence', 400, 'E400');
    }
    throw error;
  }
}));

// Get sync status (last successful sync time)
router.get('/sync-status', authenticate, asyncHandler(async (req, res) => {
  const userId = req.userId;

  // Get the most recent processed event for this user
  const result = await query(
    `SELECT MAX(timestamp) as last_sync_time, COUNT(*) as total_events
     FROM screen_events 
     WHERE user_id = $1 AND processed = true`,
    [userId]
  );

  const lastSyncTime = result.rows[0].last_sync_time;
  const totalEvents = parseInt(result.rows[0].total_events);

  // Get count of unprocessed events
  const unprocessedResult = await query(
    `SELECT COUNT(*) as unprocessed_count
     FROM screen_events 
     WHERE user_id = $1 AND processed = false`,
    [userId]
  );

  const unprocessedCount = parseInt(unprocessedResult.rows[0].unprocessed_count);

  res.json({
    lastSyncTime: lastSyncTime,
    totalEvents: totalEvents,
    unprocessedEvents: unprocessedCount,
    syncStatus: unprocessedCount === 0 ? 'up_to_date' : 'pending'
  });
}));

// Get recent events (for debugging purposes - admin only in production)
router.get('/recent', authenticate, validate(schemas.eventLimitQuery, 'query'), asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { limit } = req.query; // limit is validated and has a default from eventLimitQuerySchema

  const result = await query(
    `SELECT event_type, timestamp, device_uuid, processed, created_at
     FROM screen_events 
     WHERE user_id = $1 
     ORDER BY timestamp DESC 
     LIMIT $2`,
    [userId, limit]
  );

  res.json({
    events: result.rows,
    count: result.rows.length
  });
}));

// Force reprocess unprocessed events (utility endpoint)
router.post('/reprocess', authenticate, asyncHandler(async (req, res) => {
  const userId = req.userId;

  // Get unprocessed events
  const result = await query(
    `SELECT event_type, timestamp, device_uuid
     FROM screen_events 
     WHERE user_id = $1 AND processed = false
     ORDER BY timestamp`,
    [userId]
  );

  if (result.rows.length === 0) {
    return res.json({
      message: 'No unprocessed events found'
    });
  }

  try {
    // Process the unprocessed events
    const processResult = await processEvents(result.rows, userId);

    res.json({
      message: 'Events reprocessed successfully',
      sessionsProcessed: processResult.sessionsProcessed,
      totalScore: processResult.totalScore
    });

  } catch (error) {
    throw new AppError('Failed to reprocess events', 500, 'E500');
  }
}));

module.exports = router;
