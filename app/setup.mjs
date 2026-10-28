import { access, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON } from './store.mjs';

const fields = ['leagueId', 'expectedTeams', 'model', 'endpoint', 'apiKey', 'cdpUrl'];
export async function loadSettings(config) {
  try {
    const saved = JSON.parse(await readFile(join(config.dataDir, 'settings.json'), 'utf8'));
    for (const field of fields) if (Object.hasOwn(saved, field)) config[field] = saved[field];
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export async function saveSettings(config, patch, hasEvidence) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !fields.includes(k))) throw new Error('Invalid setup fields');
  const next = { ...config, ...patch };
  if (typeof next.leagueId !== 'string' || !/^\d{1,12}$/.test(next.leagueId)) throw new Error('Invalid league ID');
  if (hasEvidence && next.leagueId !== config.leagueId) throw new Error('Invalid league change: this volume already contains league evidence');
  if (!Number.isInteger(next.expectedTeams) || next.expectedTeams < 2 || next.expectedTeams > 30) throw new Error('Invalid team count');
  for (const key of ['model', 'endpoint', 'apiKey', 'cdpUrl']) if (typeof next[key] !== 'string' || next[key].length > 4096) throw new Error('Invalid connection setting');
  let endpoint;
  try { endpoint = new URL(next.endpoint); } catch { throw new Error('Invalid model endpoint'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) throw new Error('Invalid model endpoint: use an HTTPS chat-completions URL without credentials or query parameters');
  if (next.cdpUrl) {
    let cdp; try { cdp = new URL(next.cdpUrl); } catch { throw new Error('Invalid browser connection'); }
    if (!['https:', 'wss:'].includes(cdp.protocol)) throw new Error('Invalid browser connection: use HTTPS or WSS');
  }
  const saved = Object.fromEntries(fields.map(k => [k, next[k]]));
  await atomicJSON(join(config.dataDir, 'settings.json'), saved);
  Object.assign(config, saved);
}
export async function setupStatus(config) {
  let sessionSaved = false;
  try { await access(join(config.dataDir, 'auth', 'yahoo.json')); sessionSaved = true; } catch {}
  return { league_id: config.leagueId, expected_teams: config.expectedTeams, model: config.model, endpoint: config.endpoint, api_key_saved: Boolean(config.apiKey), remote_browser_saved: Boolean(config.cdpUrl), yahoo_session_saved: sessionSaved };
}
const yahooDomain = domain => typeof domain === 'string' && /(^|\.)yahoo\.com$/.test(domain);
export function yahooState(input) {
  if (!input || !Array.isArray(input.cookies) || !input.cookies.length || !Array.isArray(input.origins)) throw new Error('Invalid Yahoo session: upload the browser-state JSON from the login helper');
  if (input.cookies.length > 300 || input.origins.length > 30) throw new Error('Invalid Yahoo session size');
  const cookies = input.cookies.map(c => {
    if (!c || !yahooDomain(c.domain) || typeof c.name !== 'string' || !c.name || typeof c.value !== 'string' || typeof c.path !== 'string' || !c.path.startsWith('/') || !Number.isFinite(c.expires) || typeof c.httpOnly !== 'boolean' || typeof c.secure !== 'boolean' || !['Strict', 'Lax', 'None'].includes(c.sameSite)) throw new Error('Invalid Yahoo session cookie; only Yahoo login state is supported');
    return Object.fromEntries(['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite', 'partitionKey'].filter(k => Object.hasOwn(c, k)).map(k => [k, c[k]]));
  });
  const origins = input.origins.map(o => {
    let url; try { url = new URL(o.origin); } catch { throw new Error('Invalid Yahoo session origin'); }
    if (url.protocol !== 'https:' || !yahooDomain(url.hostname) || url.origin !== o.origin || !Array.isArray(o.localStorage) || o.localStorage.some(v => !v || typeof v.name !== 'string' || typeof v.value !== 'string')) throw new Error('Invalid Yahoo session origin');
    return { origin: o.origin, localStorage: o.localStorage.map(({ name, value }) => ({ name, value })) };
  });
  return { cookies, origins };
}
export async function saveYahooState(config, input) {
  const state = yahooState(input);
  await mkdir(join(config.dataDir, 'auth'), { recursive: true, mode: 0o700 });
  await atomicJSON(join(config.dataDir, 'auth', 'yahoo.json'), state);
  await saveSettings(config, { cdpUrl: '' }, false);
}
