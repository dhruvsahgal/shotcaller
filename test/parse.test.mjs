import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePage } from '../app/parse.mjs';
const raw = { url: 'https://basketball.fantasysports.yahoo.com/nba/12345/7', text: 'Roster date 2026-10-27', controls: [], links: [], tables: [{ headers: ['Players', 'FGM/A*', 'FTM/A*', 'OREB', 'REB', 'ST'], rows: [{ cells: ['Example Player\nOKC - PG', '3/7', '0/0', '2', '5', '-'], links: [{ text: 'Example Player', href: 'https://sports.yahoo.com/nba/players/1234/' }] }] }] };
test('header-based extraction preserves identity, unknown stats and shooting denominators', () => {
  const page = parsePage(raw, 'roster', '7');
  assert.equal(page.rows[0].id, '1234');
  assert.equal(page.rows[0].stats.fgm, 3);
  assert.equal(page.rows[0].stats.stl, null);
  assert.equal(page.rows[0].stats.ft_pct, null);
  assert.equal(page.team_id, '7');
});
test('login redirects and Team Log masquerading as roster fail', () => {
  assert.throws(() => parsePage({ ...raw, url: 'https://login.yahoo.com/' }, 'roster'), /Sign in/);
  assert.throws(() => parsePage({ ...raw, url: `${raw.url}/teamlog` }, 'roster'), /Team Log/);
  assert.throws(() => parsePage(raw, 'roster', '9'), /requested team/);
});
test('unexpected tables cannot pass as complete stats or empty transaction history', () => {
  const changed = { ...raw, tables: [{ headers: ['Team', 'Unexpected metric'], rows: [{ cells: ['Example team', '100'], links: [{ text: 'Example team', href: raw.url }] }] }] };
  assert.match(parsePage(changed, 'teamstats').warnings.join(' '), /stat columns/);
  assert.match(parsePage(changed, 'transactions').warnings.join(' '), /transaction/);
  const empty = { ...raw, text: 'No transactions found', tables: [] };
  assert.deepEqual(parsePage(empty, 'transactions').warnings, []);
  assert.deepEqual(parsePage({ ...empty, text: 'No players found' }, 'players').warnings, []);
});
