import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, atomicJSON } from './store.mjs';
import { configuration } from './config.mjs';
import { analyze } from './analysis.mjs';
import { makeDecision, promptInfo, tasks } from './decisions.mjs';
import { refreshYahoo } from './yahoo.mjs';
import { loadSettings, saveSettings, setupStatus, saveYahooState } from './setup.mjs';

const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
function authorized(req, token) {
  const supplied = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return token.length >= 24 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function body(req, limit = 32000) {
  let size = 0; const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw new Error('Request too large');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString() || '{}');
}
export async function createApp(config, options = {}) {
  if (config.token.length < 24) throw new Error('APP_TOKEN must contain at least 24 characters');
  const store = options.store || new Store(config.dataDir);
  await store.init();
  await loadSettings(config);
  let refresh = { status: 'idle', detail: 'No refresh in this process', updated_at: null };
  try {
    refresh = JSON.parse(await readFile(join(config.dataDir, 'refresh.json'), 'utf8'));
    if (refresh.status === 'running') refresh = { ...refresh, status: 'interrupted', detail: 'Previous refresh interrupted; last good snapshot retained' };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let refreshing = false, deciding = false, configuring = false;
  const update = async (status, detail) => { refresh = { status, detail, updated_at: new Date().toISOString() }; await atomicJSON(join(config.dataDir, 'refresh.json'), refresh); };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        res.writeHead(200, { 'Content-Type': type }); return res.end(await readFile(new URL(`../public/${file}`, import.meta.url)));
      }
      if (!authorized(req, config.token)) return send(401, { error: 'Enter your ShotCaller access token' });
      if (req.method === 'GET' && url.pathname === '/api/setup') return send(200, await setupStatus(config));
      if (req.method === 'POST' && ['/api/setup', '/api/setup/yahoo', '/api/import'].includes(url.pathname)) {
        if (refreshing || deciding || configuring) return send(409, { error: 'Wait for the current operation to finish' });
        configuring = true;
        try {
          const input = await body(req, url.pathname === '/api/setup' ? 32000 : 512000);
          if (url.pathname === '/api/import') {
            const record = await store.importHistorical(input);
            return send(201, { id: record.id, status: record.status });
          }
          if (url.pathname === '/api/setup/yahoo') await saveYahooState(config, input);
          else await saveSettings(config, input, (await store.list()).length > 0);
          return send(200, await setupStatus(config));
        } finally { configuring = false; }
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const records = await store.list(), decisions = await store.list('decisions');
        let prompt; try { const p = await promptInfo(config.promptPath); prompt = { hash: p.hash, text: p.text, ready: true }; } catch { prompt = { ready: false, error: 'Master prompt unavailable; decisions disabled' }; }
        return send(200, { league_id: config.leagueId, refresh, model_configured: Boolean(config.apiKey && config.model), tasks, prompt, latest_id: (await store.latest())?.id || null, snapshots: records.map(({ id, kind, status, stored_at, observed_at, warnings, payload }) => ({ id, kind, status, stored_at, observed_at: observed_at || payload?.source?.captured_at || null, label: payload?.kind || kind, warnings: warnings || payload?.quality_notes || [] })), analysis: analyze(records), decisions });
      }
      if (req.method === 'GET' && /^\/api\/snapshots\/[^/]+$/.test(url.pathname)) return send(200, await store.read(decodeURIComponent(url.pathname.split('/').at(-1))));
      if (req.method === 'POST' && url.pathname === '/api/refresh') {
        if (refreshing || configuring) return send(409, { error: 'A refresh or setup change is already running' });
        refreshing = true;
        try { await update('running', 'Opening collector browser'); }
        catch (error) { refreshing = false; throw error; }
        send(202, refresh);
        const collect = options.collect || refreshYahoo;
        void collect(config, store, detail => { refresh = { ...refresh, detail }; }).then(result => update(result.status, result.status === 'complete' ? 'League capture saved' : 'Incomplete capture saved; last complete capture retained')).catch(error => update('failed', /login required|Run npm run login/.test(error.message) ? error.message : 'Refresh failed; check browser access and collection settings')).finally(() => { refreshing = false; }).catch(() => { refresh = { status: 'failed', detail: 'Unable to persist refresh status' }; });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/decisions') {
        if (deciding || configuring) return send(409, { error: 'A decision or setup change is already running' });
        deciding = true;
        try { return send(201, await makeDecision(await body(req), config, store)); }
        finally { deciding = false; }
      }
      return send(404, { error: 'Not found' });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const known = /^(Invalid|Unsupported|Select|A question|Follow-up|Previous decision|Configure|Model |Evidence |ShotCaller |Request too large)/.test(error.message);
      send(error.code === 'ENOENT' ? 404 : 400, { error: known ? error.message : 'Request failed; check the input and service configuration' });
    }
  });
  server.requestTimeout = 70000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = configuration();
  const server = await createApp(config);
  server.listen(config.port, config.host, () => console.log(`ShotCaller listening on ${config.host}:${config.port}`));
}
