import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpponentProfiles, estimateClaimRisk, screenTrades } from '../app/opponents.mjs';

const event = (id, day, overrides = {}) => ({
  id, team_id: 'rival', type: 'add', occurred_at: `2026-11-${String(day).padStart(2, '0')}T10:00:00Z`,
  confirmed: true, categories: ['stl'], source_ids: [`source-${id}`], ...overrides
});

test('one move is evidence, not a confident manager tendency', () => {
  const profile = buildOpponentProfiles({ as_of: '2026-11-14T00:00:00Z', team_ids: ['rival'], events: [event('one', 10)] }).profiles[0];
  assert.equal(profile.sample_size.confirmed_moves, 1);
  assert.deepEqual(profile.tendencies, []);
  assert.match(profile.notes[0], /hypoth/i);
});

test('repeated confirmed moves across dates create a cited tendency while injury moves do not', () => {
  const events = [event('a', 8), event('b', 9), event('c', 10), event('injury', 11, { injury_driven: true })];
  const profile = buildOpponentProfiles({ as_of: '2026-11-14T00:00:00Z', team_ids: ['rival'], events }).profiles[0];
  assert.equal(profile.tendencies[0].category, 'stl');
  assert.equal(profile.tendencies[0].confidence, 'low');
  assert.deepEqual(profile.tendencies[0].evidence_ids, ['a', 'b', 'c']);
  assert.equal(profile.sample_size.injury_driven_moves, 1);
});

test('rejected trades stay separate and cannot become completed trades', () => {
  const profile = buildOpponentProfiles({ as_of: '2026-11-14T00:00:00Z', team_ids: ['rival'], events: [
    event('rejected', 10, { type: 'trade_rejected', confirmed: true, categories: [] })
  ] }).profiles[0];
  assert.equal(profile.sample_size.completed_trades, 0);
  assert.equal(profile.sample_size.rejected_trades, 1);
});

test('claim risk is bounded and reports its evidence strength', () => {
  const events = [event('a', 8), event('b', 9), event('c', 10), event('d', 11), event('e', 12)];
  const profile = buildOpponentProfiles({ as_of: '2026-11-14T00:00:00Z', team_ids: ['rival'], events }).profiles[0];
  const risk = estimateClaimRisk(profile, ['stl'], 0.8);
  assert.ok(risk.score > 0 && risk.score <= 1);
  assert.equal(risk.confidence, 'medium');
  assert.deepEqual(risk.evidence_ids, ['a', 'b', 'c', 'd', 'e']);
});

test('trade screens identify mutual category fit without assuming acceptance', () => {
  const result = screenTrades({ manager_needs: ['ast'], candidates: [{
    id: 'trade-1', other_team_id: 'rival', give_player_id: 'mine', receive_player_id: 'theirs',
    receive_strengths: ['ast', 'pts'], give_strengths: ['reb'], counterparty_needs: ['reb'], source_ids: ['roster-a', 'roster-b']
  }] });
  assert.equal(result[0].mutual_fit, true);
  assert.equal(result[0].acceptance, 'unknown');
  assert.equal(result[0].status, 'screened_not_proposed');
});

