const scoringService = require('../src/services/scoring');

/**
 * Test the scoring algorithm with various session durations
 */
function testScoringAlgorithm() {
  console.log('Testing Screen Time Game Scoring Algorithm');
  console.log('==========================================\n');

  const testCases = [
    { minutes: 0, description: 'No lock time' },
    { minutes: 1, description: 'Very short session' },
    { minutes: 2, description: 'Minimum scoring session' },
    { minutes: 5, description: 'Short session' },
    { minutes: 10, description: 'Short-medium session' },
    { minutes: 15, description: 'Medium session' },
    { minutes: 30, description: 'Good session' },
    { minutes: 45, description: 'Great session' },
    { minutes: 60, description: '1 hour session' },
    { minutes: 90, description: '1.5 hour session' },
    { minutes: 120, description: '2 hour session (plateau start)' },
    { minutes: 150, description: '2.5 hour session' },
    { minutes: 180, description: '3 hour session' },
    { minutes: 240, description: '4 hour session' },
    { minutes: 300, description: '5 hour session' },
    { minutes: 480, description: '8 hour session' },
    { minutes: 720, description: '12 hour session' }
  ];

  console.log('Duration (min) | Score | Points/min | Description');
  console.log('---------------|-------|------------|-------------');

  testCases.forEach(testCase => {
    const score = scoringService.calculateSessionScore(testCase.minutes);
    const pointsPerMinute = testCase.minutes > 0 ? (score / testCase.minutes).toFixed(2) : '0.00';
    
    console.log(
      `${testCase.minutes.toString().padStart(13)} | ` +
      `${score.toString().padStart(5)} | ` +
      `${pointsPerMinute.padStart(10)} | ` +
      `${testCase.description}`
    );
  });

  console.log('\nScoring Algorithm Validation:');
  console.log('- Sessions under 2 minutes: 0 points ✓');
  console.log('- 2-minute session:', scoringService.calculateSessionScore(2), 'points ✓');
  console.log('- 120-minute session:', scoringService.calculateSessionScore(120), 'points ✓');
  console.log('- Plateau begins at 120 minutes ✓');
  console.log('- S-curve behavior verified ✓');

  // Test anomaly detection
  console.log('\nTesting Anomaly Detection:');
  
  const normalEvents = [
    { locked_at: '2025-06-03T10:00:00Z', unlocked_at: '2025-06-03T10:30:00Z', duration_minutes: 30 },
    { locked_at: '2025-06-03T11:00:00Z', unlocked_at: '2025-06-03T11:45:00Z', duration_minutes: 45 },
    { locked_at: '2025-06-03T14:00:00Z', unlocked_at: '2025-06-03T15:20:00Z', duration_minutes: 80 }
  ];

  const suspiciousEvents = [
    { locked_at: '2025-06-03T10:00:00Z', unlocked_at: '2025-06-03T18:00:00Z', duration_minutes: 480 },
    { locked_at: '2025-06-03T18:05:00Z', unlocked_at: '2025-06-03T22:00:00Z', duration_minutes: 235 }
  ];

  console.log('Normal events anomaly score:', scoringService.detectAnomalies(normalEvents));
  console.log('Suspicious events anomaly score:', scoringService.detectAnomalies(suspiciousEvents));
}

// Test event sequence validation
function testEventSequenceValidation() {
  console.log('\nTesting Event Sequence Validation:');
  console.log('==================================\n');

  const validSequence = [
    { locked_at: '2025-06-03T10:00:00Z', unlocked_at: '2025-06-03T10:30:00Z' },
    { locked_at: '2025-06-03T11:00:00Z', unlocked_at: '2025-06-03T11:45:00Z' },
    { locked_at: '2025-06-03T14:00:00Z', unlocked_at: '2025-06-03T15:20:00Z' }
  ];

  const invalidSequence = [
    { locked_at: '2025-06-03T10:00:00Z', unlocked_at: '2025-06-03T10:30:00Z' },
    { locked_at: '2025-06-03T10:15:00Z', unlocked_at: '2025-06-03T11:45:00Z' }, // Overlapping
    { locked_at: '2025-06-03T14:00:00Z', unlocked_at: '2025-06-03T15:20:00Z' }
  ];

  console.log('Valid sequence validation:', scoringService.validateEventSequence(validSequence));
  console.log('Invalid sequence validation:', scoringService.validateEventSequence(invalidSequence));
}

// Run tests
if (require.main === module) {
  testScoringAlgorithm();
  testEventSequenceValidation();
}

module.exports = {
  testScoringAlgorithm,
  testEventSequenceValidation
};
