import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryValue } from '../app/categories.mjs';

test('shooting percentages use pooled finite makes and attempts only', () => {
  assert.equal(categoryValue({ fgm: 4, fga: 10, fg_pct: .99 }, 'fg_pct'), .4);
  assert.equal(categoryValue({ ftm: 7, fta: 8, ft_pct: .01 }, 'ft_pct'), .875);
  assert.equal(categoryValue({ fg_pct: .75 }, 'fg_pct'), null);
  assert.equal(categoryValue({ fgm: 0, fga: 0, fg_pct: .75 }, 'fg_pct'), null);
  assert.equal(categoryValue({ fgm: Number.NaN, fga: 10 }, 'fg_pct'), null);
});
