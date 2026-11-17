import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDailyContributionRows, normalizeDailyLineupRows, normalizeMatchupRows, normalizeRosterRows } from '../app/league-page-normalize.mjs';

const parsedRoster = {
  rows: [
    { id: '10', name: 'Starter', fields: { Pos: 'PG', Players: 'Starter\nOKC - PG,SG' }, stats: { pts: 12, fgm: 4, fga: 8 } },
    { id: '11', name: 'Bench', fields: { Pos: 'BN', Players: 'Bench\nBOS - SF' }, stats: { pts: 20, fgm: 8, fga: 12 } },
    { id: '12', name: 'Injured', fields: { Pos: 'IL', Players: 'Injured\nLAL - PF\nO' }, stats: { pts: null, fgm: null, fga: null } }
  ]
};

test('roster and daily normalizers preserve slots while excluding bench and IL from counted contributions', () => {
  const roster = normalizeRosterRows(parsedRoster, '7');
  assert.deepEqual(roster.map(row => row.slot_group), ['active', 'bench', 'il']);
  assert.deepEqual(roster[0].eligibility, ['PG', 'SG']);
  assert.equal(normalizeDailyLineupRows(parsedRoster, '7').length, 3);
  const contributions = normalizeDailyContributionRows(parsedRoster, '7');
  assert.deepEqual(contributions.map(row => row.player_id), ['10']);
  assert.equal(contributions[0].fantasy_counted, true);
});

test('matchup normalizer keeps only the declared pair', () => {
  const parsed = { rows: [
    { id: '7', name: 'Mine', stats: { pts: 100 } },
    { id: '2', name: 'Theirs', stats: { pts: 90 } },
    { id: '9999', name: 'Player row', stats: { pts: 20 } }
  ] };
  assert.deepEqual(normalizeMatchupRows(parsed, ['2', '7']).map(row => row.team_id), ['7', '2']);
});
