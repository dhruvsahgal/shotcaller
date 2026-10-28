import { chromium } from 'playwright';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { parsePage, extractVisiblePage } from './parse.mjs';

export async function browserSession(config) {
  if (config.cdpUrl) {
    const browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 20000 });
    const context = browser.contexts()[0];
    if (!context) { await browser.close(); throw new Error('Remote browser has no authenticated context'); }
    return { context, close: () => browser.close() };
  }
  const state = join(config.dataDir, 'auth', 'yahoo.json');
  try { await access(state); } catch { throw new Error('Yahoo login required. Run npm run login on your computer first.'); }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: state, timezoneId: 'Asia/Singapore' });
    return { context, close: () => browser.close() };
  } catch (error) { await browser.close(); throw error; }
}
export function leagueURL(url, leagueId, origin = 'https://basketball.fantasysports.yahoo.com') {
  const u = new URL(url);
  if (u.origin !== origin || !(u.pathname === `/nba/${leagueId}` || u.pathname.startsWith(`/nba/${leagueId}/`))) throw new Error('Navigation outside the configured league rejected');
  return u.href;
}
export async function collectLeague(context, config, progress = () => {}) {
  const leagueId = config.leagueId;
  if (!/^\d+$/.test(leagueId)) throw new Error('Invalid league ID');
  const origin = config.origin || 'https://basketball.fantasysports.yahoo.com';
  const base = `${origin}/nba/${leagueId}`;
  const page = await context.newPage();
  const pages = [], warnings = [], teams = new Map();
  const visit = async (url, kind, teamId) => {
    progress(`Reading ${kind}${teamId ? ` · team ${teamId}` : ''}`);
    const response = await page.goto(leagueURL(url, leagueId, origin), { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (response && !response.ok()) throw new Error(`Yahoo page returned HTTP ${response.status()}`);
    await page.locator('table, input[type=password], form[action*="login"]').first().waitFor({ timeout: 15000 }).catch(() => {});
    const raw = await page.evaluate(extractVisiblePage);
    leagueURL(raw.url, leagueId, origin); // redirects to login never become league data
    const parsed = parsePage(raw, kind, teamId);
    if (raw.truncated) parsed.warnings.push('Page text exceeded capture limit');
    if (!raw.tables.length && !parsed.empty_verified) parsed.warnings.push('No tables found; page format or login requires inspection');
    pages.push(parsed);
    warnings.push(...parsed.warnings.map(w => `${kind}${teamId ? `/${teamId}` : ''}: ${w}`));
    return parsed;
  };
  const paginated = async (path, kind) => {
    let url = `${base}/${path}`, count = 0;
    const seen = new Set();
    while (url) {
      if (seen.has(url)) { warnings.push(`${kind}: pagination cycle`); break; }
      if (count >= config.maxPages) { warnings.push(`${kind}: page limit reached; coverage incomplete`); break; }
      seen.add(url); count++;
      const parsed = await visit(url, kind);
      url = parsed.raw.next;
      parsed.pagination = { page: count, terminal: !url && (parsed.raw.next_disabled || parsed.rows.length < 25) };
      if (!url && !parsed.pagination.terminal) warnings.push(`${kind}: final page could not be verified`);
    }
  };
  try {
    const overview = await visit(base, 'league');
    for (const l of overview.raw.links) {
      const u = new URL(l.href), match = u.pathname.match(new RegExp(`^/nba/${leagueId}/(\\d+)/?$`));
      if (match && l.text && u.origin === origin && !teams.has(match[1])) teams.set(match[1], { id: match[1], name: l.text });
    }
    if (teams.size !== config.expectedTeams) warnings.push(`Expected ${config.expectedTeams} teams, discovered ${teams.size}`);
    await visit(`${base}/settings`, 'settings');
    await visit(`${base}/matchup`, 'matchup');
    const stats = await visit(`${base}/teamstats`, 'teamstats');
    if (new Set(stats.rows.map(row => row.id)).size !== config.expectedTeams || stats.rows.some(row => !teams.has(row.id))) warnings.push('Team statistics do not cover the discovered league teams');
    for (const team of teams.values()) await visit(`${base}/${team.id}`, 'roster', team.id);
    await paginated('players?status=FA', 'players');
    await paginated('players?status=W', 'players');
    await paginated('transactions', 'transactions');
  } catch (error) {
    // Provider/browser errors can contain signed URLs; keep a safe public summary.
    warnings.push(/outside.*league/i.test(error.message) ? 'Yahoo redirected outside the league; login may be required' : /Sign in|HTTP|login required/.test(error.message) ? error.message : 'Page capture failed; inspect Yahoo access or page layout');
  } finally { await page.close(); }
  return { league_id: leagueId, observed_at: new Date().toISOString(), status: warnings.length ? 'partial' : 'complete', teams: [...teams.values()], pages, warnings: [...new Set(warnings)], parser_version: 1, scope: 'all teams; displayed matchup/stat periods; FA and waiver pages; paginated transaction history' };
}
export async function refreshYahoo(config, store, progress) {
  const session = await browserSession(config);
  try { return await store.saveCapture(await collectLeague(session.context, config, progress)); }
  finally { await session.close(); }
}
