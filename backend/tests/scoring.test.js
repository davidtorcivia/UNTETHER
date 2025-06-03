const scoringService = require('../src/services/scoring');

describe('Scoring Algorithm', () => {
  test('should return 0 for sessions under 2 minutes', () => {
    expect(scoringService.calculateSessionScore(0)).toBe(0);
    expect(scoringService.calculateSessionScore(1)).toBe(0);
    expect(scoringService.calculateSessionScore(1.9)).toBe(0);
  });

  test('should return positive score for sessions 2 minutes or longer', () => {
    expect(scoringService.calculateSessionScore(2)).toBe(5);
    expect(scoringService.calculateSessionScore(30)).toBe(18);
    expect(scoringService.calculateSessionScore(60)).toBe(58);
    expect(scoringService.calculateSessionScore(120)).toBe(95);
  });

  test('should plateau around 120 minutes', () => {
    const score120 = scoringService.calculateSessionScore(120);
    const score240 = scoringService.calculateSessionScore(240);
    const score360 = scoringService.calculateSessionScore(360);
    
    // Score should still increase but at a much slower rate
    expect(score240).toBeGreaterThan(score120);
    expect(score360).toBeGreaterThan(score240);
    
    // But the increase should be much smaller after 120 minutes
    const firstHourIncrease = score120 - scoringService.calculateSessionScore(60);
    const secondHourIncrease = score240 - score120;
    
    expect(secondHourIncrease).toBeLessThan(firstHourIncrease);
  });

  test('should handle edge cases', () => {
    expect(scoringService.calculateSessionScore(-5)).toBe(0);
    expect(scoringService.calculateSessionScore(null)).toBe(0);
    expect(scoringService.calculateSessionScore(undefined)).toBe(0);
    expect(scoringService.calculateSessionScore(NaN)).toBe(0);
  });
});

describe('Event Sequence Validation', () => {
  test('should validate correct sequence', () => {
    const validEvents = [
      { locked_at: '2025-06-03T10:00:00Z', unlocked_at: '2025-06-03T10:30:00Z' },
      { locked_at: '2025-06-03T11:00:00Z', unlocked_at: '2025-06-03T11:45:00Z' },
      { locked_at: '2025-06-03T14:00:00Z', unlocked_at: '2025-06-03T15:20:00Z' }
    ];

    const result = scoringService.validateEventSequence(validEvents);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('should detect overlapping events', () => {
    const overlappingEvents = [
      { locked_at: '2025-06-03T10:00:00Z', unlocked_at: '2025-06-03T10:30:00Z' },
      { locked_at: '2025-06-03T10:15:00Z', unlocked_at: '2025-06-03T11:45:00Z' }
    ];

    const result = scoringService.validateEventSequence(overlappingEvents);
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('should detect events with unlock before lock', () => {
    const invalidEvents = [
      { locked_at: '2025-06-03T10:30:00Z', unlocked_at: '2025-06-03T10:00:00Z' }
    ];

    const result = scoringService.validateEventSequence(invalidEvents);
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('Anomaly Detection', () => {
  test('should detect normal usage patterns', () => {
    const normalEvents = [
      { locked_at: '2025-06-03T10:00:00Z', unlocked_at: '2025-06-03T10:30:00Z', duration_minutes: 30 },
      { locked_at: '2025-06-03T11:00:00Z', unlocked_at: '2025-06-03T11:45:00Z', duration_minutes: 45 },
      { locked_at: '2025-06-03T14:00:00Z', unlocked_at: '2025-06-03T15:20:00Z', duration_minutes: 80 }
    ];

    const anomalyScore = scoringService.detectAnomalies(normalEvents);
    expect(anomalyScore).toBeLessThan(0.5); // Low anomaly score for normal patterns
  });

  test('should detect suspicious patterns', () => {
    const suspiciousEvents = [
      { locked_at: '2025-06-03T10:00:00Z', unlocked_at: '2025-06-03T18:00:00Z', duration_minutes: 480 },
      { locked_at: '2025-06-03T18:05:00Z', unlocked_at: '2025-06-03T22:00:00Z', duration_minutes: 235 }
    ];

    const anomalyScore = scoringService.detectAnomalies(suspiciousEvents);
    expect(anomalyScore).toBeGreaterThan(0.5); // High anomaly score for suspicious patterns
  });

  test('should handle empty events array', () => {
    const anomalyScore = scoringService.detectAnomalies([]);
    expect(anomalyScore).toBe(0);
  });
});
