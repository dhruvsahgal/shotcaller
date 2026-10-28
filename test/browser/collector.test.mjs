import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { collectLeague } from '../../app/yahoo.mjs';

const origin = 'https://basketball.fantasysports.yahoo.com';
const base = `${origin}/nba/12345`;
const player = '<a href="https://sports.yahoo.com/nba/players/1234/">Example Player</a>';
const table = (heads, rows) => `<table><thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
function markup(path, cycling = false) {
  if (path.endsWith('/players')) return table(['Player', 'PTS', 'Roster Status'], [[player, '12', 'FA']]) + (cycling ? `<a href="${base}/players?status=FA">Next 25</a>` : '');
  if (path.endsWith('/transactions')) return table(['Date', 'Transaction', 'Team'], [['Oct 28, 2026 08:00', `Add ${player}`, `<a href="${base}/9">Example Team B</a>`]]);
  if (/\/\d+$/.test(path) && path !== '/nba/12345') return table(['Player', 'FGM/A', 'FTM/A', 'PTS'], [[player, '4/8', '2/2', '12']]);
  if (path.endsWith('/teamstats')) return table(['Team', 'FG%', 'PTS'], Array.from({ length: 10 }, (_, i) => [`<a href="${base}/${i + 1}">Team ${i + 1}</a>`, '.500', String(100 + i)]));
  if (path.endsWith('/settings')) return table(['Setting', 'Value'], [['Scoring Type', 'Head-to-Head'], ['Max Weekly Adds', '2']]);
  if (path.endsWith('/matchup')) return table(['Team', 'PTS'], [[`<a href="${base}/7">Example Team A</a>`, '181'], [`<a href="${base}/9">Example Team B</a>`, '176']]);
  return table(['Team'], Array.from({ length: 10 }, (_, i) => [`<a href="${base}/${i + 1}">Team ${i + 1}</a>`]));
}
test('real Chromium extracts ten rosters and paginated evidence; cycles cannot pass as complete', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    let cycling = false;
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<main><h1>Yahoo Fantasy</h1>${markup(new URL(route.request().url()).pathname, cycling)}</main>` }));
    const config = { leagueId: '12345', expectedTeams: 10, maxPages: 3 };
    const result = await collectLeague(context, config);
    assert.equal(result.status, 'complete', JSON.stringify(result.warnings));
    assert.equal(result.pages.filter(p => p.kind === 'roster').length, 10);
    assert.equal(result.pages.find(p => p.kind === 'players').rows[0].name, 'Example Player');
    assert.equal(result.pages.find(p => p.kind === 'transactions').rows.length, 1);
    cycling = true;
    const incomplete = await collectLeague(context, config);
    assert.equal(incomplete.status, 'partial');
    assert.match(incomplete.warnings.join(' '), /cycle/);
  } finally { await browser.close(); }
});
