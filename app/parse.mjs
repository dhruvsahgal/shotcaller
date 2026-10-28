import { numeric, validateStats } from './schema.mjs';
import { digest } from './store.mjs';

const keys = { GP: 'gp', 'FG%': 'fg_pct', 'FT%': 'ft_pct', '3PTM': 'three_pm', '3PM': 'three_pm', PTS: 'pts', OREB: 'oreb', REB: 'reb', AST: 'ast', ST: 'stl', STL: 'stl', BLK: 'blk' };
const label = s => s.replaceAll('*', '').replace(/\s+/g, ' ').trim();
export function parsePage(raw, kind, teamId = null) {
  if (/login\.yahoo|consent\.yahoo/.test(raw.url) || /sign in to (?:view|access|continue)/i.test(raw.text)) throw new Error('Sign in to Yahoo in the collector browser');
  if (kind === 'roster' && /teamlog/.test(raw.url)) throw new Error('Team Log cannot establish current roster ownership');
  if (kind === 'roster' && teamId && new URL(raw.url).pathname.replace(/\/$/, '').split('/').at(-1) !== teamId) throw new Error('Roster URL does not match the requested team');
  const warnings = [], rows = [];
  for (const table of raw.tables) {
    const headers = table.headers.map(label);
    for (const row of table.rows) {
      const player = row.links.find(l => /\/nba\/players\/\d+/.test(l.href));
      const team = row.links.find(l => /\/nba\/\d+\/\d+\/?(?:\?|$)/.test(l.href));
      const fields = Object.fromEntries(headers.map((h, i) => [h || `column_${i}`, row.cells[i] ?? null]));
      if (row.cells.length !== headers.length) {
        if (player || team) warnings.push('Column count mismatch; affected row preserved as raw evidence');
        continue;
      }
      if (['roster', 'players'].includes(kind) && !player) continue;
      if (kind === 'teamstats' && !team) continue;
      const stats = {};
      for (const [h, value] of Object.entries(fields)) {
        if (keys[h]) stats[keys[h]] = numeric(value);
        if (/^(FGM|FTM)\s*\/\s*(?:FGA|FTA|A)$/.test(h)) {
          const pair = String(value).split('/').map(numeric), prefix = h.startsWith('FG') ? 'fg' : 'ft';
          if (pair.length === 2) {
            stats[`${prefix}m`] = pair[0]; stats[`${prefix}a`] = pair[1];
            stats[`${prefix}_pct`] = pair[1] > 0 && pair[0] != null ? pair[0] / pair[1] : null;
          }
        }
      }
      try { validateStats(stats); } catch (error) { warnings.push(error.message); continue; }
      if (kind === 'transactions') {
        const text = row.cells.join(' | ');
        if (!/\b(add|drop|trade|waiver|claimed)\b/i.test(text)) continue;
        const players = row.links.filter(l => /\/nba\/players\/\d+/.test(l.href));
        const teams = row.links.filter(l => /\/nba\/\d+\/\d+\/?(?:\?|$)/.test(l.href));
        rows.push({ id: digest(text).slice(0, 24), text, fields, players, teams, status: /pending|proposed|reject|cancel/i.test(text) ? 'not_completed' : 'history_entry_unverified' });
      } else {
        rows.push({ id: player ? new URL(player.href).pathname.match(/players\/(\d+)/)[1] : team ? new URL(team.href).pathname.split('/')[3] : null, name: player?.text || team?.text || row.cells[0], fields, stats });
      }
    }
  }
  const emptyVerified = !rows.length && (
    kind === 'players' && /\bno players (?:found|available|match)/i.test(raw.text) ||
    kind === 'transactions' && /\bno transactions (?:found|available|yet|to display)/i.test(raw.text)
  );
  if (['roster', 'players', 'teamstats', 'transactions'].includes(kind) && !rows.length && !emptyVerified) warnings.push(`No recognizable ${kind} rows or explicit empty result`);
  if (kind === 'teamstats' && rows.some(row => !Object.keys(row.stats).length)) warnings.push('No recognizable stat columns in team statistics');
  if (kind === 'matchup' && rows.filter(row => row.id && Object.keys(row.stats).length).length < 2) warnings.push('Matchup statistics could not be verified for two teams');
  const period = { url_query: new URL(raw.url).search, controls: raw.controls, dates_in_text: [...new Set(raw.text.match(/\b20\d{2}-\d{2}-\d{2}\b/g) || [])], interpretation: 'as_displayed_unverified' };
  return { kind, team_id: teamId, url: raw.url, observed_at: new Date().toISOString(), period, rows, warnings, empty_verified: emptyVerified, raw };
}

// Runs inside the browser. Only rendered content is read; no cookies or hidden state.
export function extractVisiblePage() {
  const visible = e => e.getClientRects().length > 0;
  const root = document.querySelector('main') || document.querySelector('#bd') || document.body;
  const linksOf = e => [...e.querySelectorAll('a[href]')].filter(visible).map(a => ({ text: a.innerText.trim(), href: a.href, disabled: a.getAttribute('aria-disabled') === 'true' || a.classList.contains('disabled') }));
  const tables = [...root.querySelectorAll('table')].filter(visible).map(table => {
    const all = [...table.rows].filter(visible);
    const headingRows = all.filter(r => r.querySelector('th'));
    const heading = headingRows.filter(r => !r.querySelector('td')).at(-1) || headingRows[0];
    return { headers: heading ? [...heading.cells].map(c => c.innerText.trim()) : [], rows: all.filter(r => r !== heading && r.querySelector('td')).map(r => ({ cells: [...r.cells].map(c => c.innerText.trim()), links: linksOf(r) })) };
  });
  const links = linksOf(root).filter(l => /\/nba\//.test(l.href));
  const next = linksOf(root).find(l => /^next(?:\s+\d+)?\s*›?$/i.test(l.text));
  const text = root.innerText;
  const controls = [...root.querySelectorAll('select')].filter(visible).map(s => ({ name: s.name || s.id, value: s.value, label: s.selectedOptions[0]?.text || '' }));
  return { url: location.href, title: document.title, text: text.slice(0, 150000), truncated: text.length > 150000, tables, links, controls, next: next && !next.disabled ? next.href : null, next_disabled: Boolean(next?.disabled) };
}
