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
test('team table links retain the Yahoo team ID rather than the URL path prefix', () => {
  const teamRaw = {
    ...raw,
    tables: [{
      headers: ['Team', 'PTS'],
      rows: [{ cells: ['Example team', '181'], links: [{ text: 'Example team', href: 'https://basketball.fantasysports.yahoo.com/nba/12345/7' }] }]
    }]
  };
  const page = parsePage(teamRaw, 'teamstats');
  assert.equal(page.rows[0].id, '7');
  assert.equal(page.rows[0].stats.pts, 181);
});
test('opponent roster rows collapse Yahoo two-cell actions into the single Action header', () => {
  const opponent = {
    ...raw,
    tables: [{
      headers: ['Pos', 'Players', 'Action', 'Opp', 'PTS'],
      rows: [{
        cells: ['PG', 'Example Player\nOKC - PG', 'trade', 'watch', '@SAS', '19'],
        links: [{ text: 'Example Player', href: 'https://sports.yahoo.com/nba/players/1234/' }]
      }]
    }]
  };
  const page = parsePage(opponent, 'roster', '7');
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].fields.Action, 'trade watch');
  assert.equal(page.rows[0].fields.Opp, '@SAS');
  assert.equal(page.rows[0].stats.pts, 19);
  assert.deepEqual(page.warnings, []);
});
test('headerless Yahoo transaction rows preserve player legs and event text', () => {
  const transactions = {
    ...raw,
    url: 'https://basketball.fantasysports.yahoo.com/nba/12345/transactions',
    tables: [{
      headers: [],
      rows: [{
        cells: ['add drop', 'Example Player Free Agent Other Player To Waivers', 'Example Team Nov 16'],
        links: [
          { text: 'Example Player', href: 'https://sports.yahoo.com/nba/players/1234/' },
          { text: 'Other Player', href: 'https://sports.yahoo.com/nba/players/5678/' }
        ]
      }]
    }]
  };
  const page = parsePage(transactions, 'transactions');
  assert.equal(page.rows.length, 1);
  assert.deepEqual(page.rows[0].players.map(player => player.text), ['Example Player', 'Other Player']);
  assert.match(page.rows[0].text, /To Waivers/);
  assert.deepEqual(page.warnings, []);
});
