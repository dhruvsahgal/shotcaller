import { test } from 'node:test';
import assert from 'node:assert/strict';
import { participationScenarios } from '../app/research.mjs';

test('questionable and unreported players remain uncertainty scenarios', () => {
  assert.deepEqual(participationScenarios({ status: 'questionable', observed_at: '2026-11-14T00:00:00Z', source_ids: ['injury-1'] }), { lower: false, upper: true, status: 'questionable', sourced: true });
  assert.deepEqual(participationScenarios(null), { lower: false, upper: true, status: 'unknown', sourced: false });
  assert.deepEqual(participationScenarios({ status: 'available', observed_at: '2026-11-14T00:00:00Z', source_ids: ['team-1'] }), { lower: true, upper: true, status: 'available', sourced: true });
  assert.deepEqual(participationScenarios({ status: 'out', observed_at: '2026-11-14T00:00:00Z', source_ids: ['team-1'] }), { lower: false, upper: false, status: 'out', sourced: true });
  assert.deepEqual(participationScenarios({ status: 'suspended', observed_at: '2026-11-14T00:00:00Z', source_ids: ['team-1'] }), { lower: false, upper: false, status: 'suspended', sourced: true });
  assert.deepEqual(participationScenarios({ status: 'unknown', observed_at: '2026-11-14T00:00:00Z', source_ids: ['team-1'] }), { lower: false, upper: true, status: 'unknown', sourced: true });
  assert.deepEqual(participationScenarios({ status: 'available', observed_at: '2026-02-31T00:00:00Z', source_ids: ['team-1'] }), { lower: false, upper: true, status: 'unknown', sourced: false });
});
