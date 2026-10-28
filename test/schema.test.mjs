import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numeric, validateStats, sumStats } from '../app/schema.mjs';
test('missing is not zero and percentages use shooting volume', () => {
  assert.equal(numeric('-'), null);
  assert.equal(numeric('1,234'), 1234);
  assert.equal(numeric('12 points'), null);
  const t = sumStats([{ fgm: 1, fga: 2, ftm: 0, fta: 0, pts: 2 }, { fgm: 9, fga: 10, ftm: 0, fta: 0, pts: 18 }]);
  assert.equal(t.fg_pct, 10 / 12);
  assert.equal(t.ft_pct, null);
  assert.equal(t.reb, null);
  assert.throws(() => validateStats({ fgm: 5, fga: 4 }), /makes/);
  assert.throws(() => validateStats({ oreb: 5, reb: 4 }), /rebounds/);
});
