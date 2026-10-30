import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOverview } from '../app/overview.mjs';

const wrap = (id, payload, stored = '2026-11-01T12:00:00Z') => ({
  id, kind: 'historical_import', status: 'historical', stored_at: stored,
  payload: { snapshot_id: `source-${id}`, league_id: '123', source: {}, ...payload }
});
const matchup = (observed, points) => ({ kind: 'matchup_weekly_category_totals', week: 2,
  observed_at: observed, teams: [{ name: 'Home', stats: { pts: points } }] });

test('latest means observation time, not import order; source precision and immutable identity survive', () => {
  const newer = wrap('new', { ...matchup(undefined, 30), observed_date: '2026-10-30' });
  const lateUpload = wrap('old', matchup('2026-10-29T15:00:00Z', 20), '2026-12-01T12:00:00Z');
  const output = buildOverview([lateUpload, newer]);
  assert.equal(output.matchup.teams[0].stats.pts, 30);
  assert.equal(output.matchup.meta.observed_at, '2026-10-30');
  assert.equal(output.matchup.meta.id, 'new');
  assert.equal(output.matchup.meta.source_snapshot_id, 'source-new');
  assert.equal(output.matchup.meta.status, 'historical');
  assert.deepEqual(output.matchup_history.map(r => r.meta.id), ['new', 'old']);
});

test('unknown observation timestamps never become upload dates or outrank known observations', () => {
  const unknown = wrap('unknown', matchup(null, 999), '2030-01-01T00:00:00Z');
  const known = wrap('known', { ...matchup(null, 4), source: { captured_at: '2026-10-28' } });
  const output = buildOverview([unknown, known]);
  assert.equal(output.matchup.meta.id, 'known');
  assert.equal(output.sources[1].observed_at, null);
  assert.equal(buildOverview([unknown]).matchup.meta.observed_at, null);
});

test('lineup observations merge by scoring date without erasing earlier checked days', () => {
  const old = wrap('audit', { kind: 'daily_lineup_audit', captured_at: '2026-10-28T10:00:00Z',
    days: [{ date: '2026-10-26', playing_in_active_slots: ['A'] }, { date: '2026-10-30', benched_with_game: ['B'] }] });
  const next = wrap('check', { kind: 'standard_team_performance_check', observed_date: '2026-10-30',
    remaining_lineups: [{ date: '2026-10-30', benched_with_game: [] }, { date: '2026-10-31', playing_in_active_slots: ['B'] }] });
  const output = buildOverview([old, next]);
  assert.deepEqual(output.lineups.days.map(d => d.date), ['2026-10-26', '2026-10-30', '2026-10-31']);
  assert.equal(output.lineups.days[0].meta.id, 'audit');
  assert.equal(output.lineups.days[1].meta.id, 'check');
  assert.deepEqual(output.lineups.days[1].benched_with_game, []);
});

test('authoritative team shooting uses makes/attempts, zero attempts are null, stale players are not summed', () => {
  const input = wrap('shooting', { ...matchup('2026-10-30', 24), teams: [{ name: 'Home',
    stats: { pts: 24, fg_pct: .9, ft_pct: .7, st: 2 }, shooting: { fgm: 4, fga: 12, ftm: 0, fta: 0 },
    players: [{ stats: { pts: 999 } }] }] });
  const original = structuredClone(input);
  const stats = buildOverview([input]).matchup.teams[0].stats;
  assert.equal(stats.fg_pct, 1 / 3);
  assert.equal(stats.ft_pct, null);
  assert.equal(stats.stl, 2);
  assert.equal(stats.st, undefined);
  assert.equal(stats.pts, 24);
  assert.deepEqual(input, original);
});

test('transaction deduplication preserves displayed time and distinct observations', () => {
  const transaction = { displayed_at: 'Oct 29, 1:50 pm', team: 'Other', add: 'Player A', drop: null };
  const records = ['2026-10-29', '2026-10-30'].map((date, i) => wrap(`tx${i}`, {
    kind: 'standard_team_performance_check', observed_date: date, recent_transactions: [transaction]
  }));
  const rows = buildOverview(records).transactions;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].displayed_at, transaction.displayed_at);
  assert.equal(rows[0].meta.id, 'tx1');
  assert.equal(rows[0].observations.length, 2);
  assert.equal(rows[0].occurred_at, undefined);
  assert.equal(buildOverview(records.reverse()).transactions[0].id, rows[0].id);
});

test('Team Log does not establish ownership and historical league totals do not become the matchup', () => {
  const records = [wrap('log', { kind: 'team_log_fantasy_earned_cumulative_stats', players: [{ name: 'Former Player', stats: { st: 5 } }] }),
    wrap('league', { kind: 'league_weekly_category_totals', week: 1, teams: [{ name: 'Home', stats: { pts: 500 } }] }),
    wrap('week2', matchup('2026-10-30', 40))];
  let output = buildOverview(records);
  assert.equal(output.roster, null);
  assert.equal(output.team_log.players[0].name, 'Former Player');
  assert.equal(output.team_log.players[0].stats.stl, 5);
  assert.equal(output.league.week, 1);
  assert.equal(output.matchup.week, 2);
  assert.equal(output.matchup.teams[0].stats.pts, 40);
  records.push(wrap('roster', { kind: 'roster_membership_observation', observed_date: '2026-10-29', players: [{ name: 'Current Player' }] }));
  output = buildOverview(records);
  assert.equal(output.roster.players[0].name, 'Current Player');
});

test('raw unverified capture is linked evidence, even when newer, not replacement category totals', () => {
  const raw = { id: 'capture-x', kind: 'league_capture', league_id: '123', status: 'partial',
    observed_at: '2026-10-31T00:00:00Z', stored_at: '2026-10-31T00:00:01Z',
    pages: [{ kind: 'matchup', period: { interpretation: 'as_displayed_unverified' }, rows: [{ stats: { pts: 999 } }] }], warnings: ['Unverified period'] };
  const output = buildOverview([wrap('known', matchup('2026-10-30', 20)), raw]);
  assert.equal(output.sources.length, 2);
  assert.equal(output.sources[0].id, 'capture-x');
  assert.equal(output.matchup.teams[0].stats.pts, 20);
  assert.ok(output.gaps.some(g => /unverified period/i.test(g)));
});

test('waiver subset scope, status and recommendation remain dated source observations', () => {
  const output = buildOverview([wrap('check', { kind: 'standard_team_performance_check', observed_date: '2026-10-30',
    coverage: { waiver_scope: 'Selected five; not the full wire' },
    waiver_candidates_season_averages: [{ name: 'A', gp: 3, st: 2, fg_pct: .5 }],
    roster_status: { adds_used: 0, adds_allowed: 2 }, recommendation: { action: 'hold', reason: 'Earlier recommendation' }
  })]);
  assert.equal(output.waivers.meta.coverage.waiver_scope, 'Selected five; not the full wire');
  assert.equal(output.waivers.players[0].stats.stl, 2);
  assert.equal(output.status.adds_used, 0);
  assert.equal(output.recommendation.action, 'hold');
  assert.equal(output.recommendation.executed, undefined);
});

test('documents use latest stored version without inventing observation time; journal preserves provenance', () => {
  const bundle = (content, journal = []) => ({ kind: 'collected_documents', documents: [{ path: 'notes/a.md', title: 'Note', content }], journal });
  const decision = { id: 'decision-1', task: 'review', created_at: '2026-10-30', stored_at: '2026-10-30T10:00:00Z',
    model: 'test-model', prompt_hash: 'hash', snapshot_ids: ['known'], answer: 'Prior answer' };
  const output = buildOverview([wrap('doc1', bundle('old'), '2026-10-29T00:00:00Z'),
    wrap('doc2', bundle('new', [{ status: 'rejected_user_confirmed', decided_on: '2026-10-28', give: ['A'], receive: ['B'] }]), '2026-10-30T00:00:00Z')], [decision]);
  assert.equal(output.documents.length, 1);
  assert.equal(output.documents[0].content, 'new');
  assert.equal(output.documents[0].meta.observed_at, null);
  assert.equal(output.journal.find(j => j.status === 'rejected_user_confirmed').decided_on, '2026-10-28');
  assert.equal(output.journal.find(j => j.id === 'decision-1').prompt_hash, 'hash');
  assert.equal(output.journal[0].id, 'decision-1');
});

test('empty sources produce an honest empty overview; league selection excludes other leagues', () => {
  const output = buildOverview([]);
  assert.deepEqual(output.sources, []);
  assert.equal(output.matchup, null);
  assert.equal(output.lineups, null);
  assert.equal(output.roster, null);
  assert.ok(output.gaps.some(g => /no automatic|not automatically/i.test(g)));
  assert.ok(output.gaps.some(g => /chat/i.test(g)));
  const other = wrap('other', { ...matchup('2026-10-31', 900), league_id: '456' });
  const filtered = buildOverview([other, wrap('own', matchup('2026-10-30', 1))], [], '123');
  assert.deepEqual(filtered.sources.map(s => s.id), ['own']);
});

test('malformed legacy tables remain linked evidence without breaking the overview', () => {
  const output=buildOverview([wrap('bad',{kind:'collected_documents',documents:{unexpected:true}}),wrap('valid',matchup('2026-10-30',4))]);
  assert.equal(output.sources.length,2);
  assert.match(output.sources.find(s=>s.id==='bad').validation_error,/documents/);
  assert.equal(output.documents.length,0);
  assert.equal(output.matchup.teams[0].stats.pts,4);
  assert.ok(output.gaps.some(g=>g.includes('invalid table shapes')));
});

test('undated moves remain separate observations and distinct provider events never collapse', () => {
  const row={team:'Example',add:'Player',drop:null,displayed_at:null};
  const observations=[wrap('one',{recent_transactions:[row,row]}),wrap('two',{recent_transactions:[row]})];
  assert.equal(buildOverview(observations).transactions.length,3);
  const dated={...row,displayed_at:'Oct 29, 1:00 pm'};
  assert.equal(buildOverview([wrap('events',{recent_transactions:[{...dated,transaction_id:'x'},{...dated,transaction_id:'y'}]})]).transactions.length,2);
  assert.equal(buildOverview([wrap('a',{recent_transactions:[{...dated,transaction_id:'x'}]}),wrap('b',{recent_transactions:[{...dated,transaction_id:'x'}]})]).transactions.length,1);
});
