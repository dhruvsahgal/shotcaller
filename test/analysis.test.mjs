import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, categoryRanks } from '../app/analysis.mjs';
test('category ranks retain unknowns and duplicate transactions never inflate activity', () => {
  assert.equal(categoryRanks([{ stats: { pts: 20 } }, { stats: { pts: 10 } }])[1].ranks.pts, 2);
  assert.equal(categoryRanks([{ stats: {} }])[0].ranks.fg_pct, null);
  const page = { kind: 'transactions', observed_at: '2026-10-28', rows: [{ id: 'event-1', teams: [{ text: 'Example Team B', href: '/9' }] }] };
  const captures = ['a', 'b'].map(id => ({ id, kind: 'league_capture', status: 'complete', observed_at: `2026-10-2${id === 'a' ? 7 : 8}`, pages: [page] }));
  assert.equal(analyze(captures).manager_activity[0].observed_events, 1);
});
