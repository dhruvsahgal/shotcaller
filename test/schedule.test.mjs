import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignLineup, positionFits, scoringDate } from '../app/schedule.mjs';

test('scoring dates use the league timezone across Singapore midnight and US daylight saving', () => {
  assert.equal(scoringDate('2026-11-02T00:30:00+08:00', 'America/Los_Angeles'), '2026-11-01');
  assert.equal(scoringDate('2026-03-09T15:30:00+08:00', 'America/Los_Angeles'), '2026-03-09');
});

test('thirteen scheduled players yield ten legal starts and preserve a locked starter', () => {
  const slots = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'Util', 'Util', 'Util'];
  const players = [
    { id: 'locked', eligible_positions: ['PG'], locked_slot: 'PG', value: 1 },
    { id: 'pg', eligible_positions: ['PG'], value: 20 },
    { id: 'sg', eligible_positions: ['SG'], value: 19 },
    { id: 'g', eligible_positions: ['PG', 'SG'], value: 18 },
    { id: 'sf', eligible_positions: ['SF'], value: 17 },
    { id: 'pf', eligible_positions: ['PF'], value: 16 },
    { id: 'f', eligible_positions: ['SF', 'PF'], value: 15 },
    { id: 'c', eligible_positions: ['C'], value: 14 },
    { id: 'u1', eligible_positions: ['C'], value: 13 },
    { id: 'u2', eligible_positions: ['SF'], value: 12 },
    { id: 'bench-1', eligible_positions: ['PG'], value: 11 },
    { id: 'bench-2', eligible_positions: ['SG'], value: 10 },
    { id: 'bench-3', eligible_positions: ['PF'], value: 9 }
  ];
  const result = assignLineup(players, slots);
  assert.equal(result.assignments.length, 10);
  assert.equal(result.bench.length, 3);
  assert.equal(result.assignments.find(row => row.player_id === 'locked').slot, 'PG');
  assert.equal(result.assignments.some(row => row.player_id === 'pg'), true);
});

test('a player locked to the bench cannot be inserted into an active slot', () => {
  const result = assignLineup([
    { id: 'locked-bench', eligible_positions: ['PG'], locked_slot: 'BN', value: 50 },
    { id: 'starter', eligible_positions: ['PG'], value: 1 }
  ], ['PG']);
  assert.deepEqual(result.assignments.map(row => row.player_id), ['starter']);
  assert.deepEqual(result.bench.map(row => row.player_id), ['locked-bench']);
});

test('every selected player is eligible for the assigned slot', () => {
  const players = [
    { id: 'guard', eligible_positions: ['PG'], value: 5 },
    { id: 'wing', eligible_positions: ['SF'], value: 4 },
    { id: 'center', eligible_positions: ['C'], value: 3 }
  ];
  const result = assignLineup(players, ['SG', 'G', 'F', 'C']);
  const byId = new Map(players.map(player => [player.id, player]));
  assert.ok(result.assignments.every(row => positionFits(byId.get(row.player_id).eligible_positions, row.slot)));
  assert.equal(result.assignments.some(row => row.player_id === 'guard' && row.slot === 'SG'), false);
});

test('accepted maximum lineup size completes with unique legal assignments', () => {
  const players = Array.from({ length: 30 }, (_, index) => ({ id: `p${index}`, eligible_positions: ['PG', 'SG', 'SF', 'PF', 'C'], value: 30 - index }));
  const slots = Array.from({ length: 20 }, () => 'Util');
  const result = assignLineup(players, slots);
  assert.equal(result.assignments.length, 20);
  assert.equal(new Set(result.assignments.map(row => row.player_id)).size, 20);
});
