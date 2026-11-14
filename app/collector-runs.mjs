import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON, canonicalDigest } from './store.mjs';
import { validateEvidenceScope, validateIdentifier, validateTimestamp } from './schema.mjs';
import { validateCollectorRequest } from '../scripts/validate-collector-output.mjs';

const interval = 12 * 60 * 60_000;
const firstSlot = Date.parse('2000-01-01T06:00:00+08:00');
export function collectionSlot(now = Date.now()) {
  return new Date(firstSlot + Math.floor((now - firstSlot) / interval) * interval).toISOString();
}
export function nextCollectionSlot(now = Date.now()) { return new Date(Date.parse(collectionSlot(now)) + interval).toISOString(); }
export function rosterAllowedPages(scope) {
  const page = `https://basketball.fantasysports.yahoo.com/nba/${scope.league_id}/${scope.team_id}`;
  if (!validateCollectorRequest({ method: 'GET', url: page, allowedPages: [page] }).allowed) throw new Error('Invalid collector roster page');
  return [page];
}

export class CollectorRuns {
  constructor(config, store, { now = () => Date.now(), fetcher = fetch } = {}) {
    this.config = config; this.store = store; this.now = now; this.fetcher = fetcher;
    this.root = join(config.dataDir, 'collector');
    this.queue = Promise.resolve();
  }
  serial(operation) {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.catch(() => {});
    return pending;
  }
  async settings() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { return JSON.parse(await readFile(join(this.root, 'schedule.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const initial = { version: 1, timezone: 'Asia/Singapore', times: ['06:00', '18:00'], paused: true, scope: null, next_run: nextCollectionSlot(this.now()), last_slot: null };
      await atomicJSON(join(this.root, 'schedule.json'), initial);
      return initial;
    }
  }
  async configure(input) {
    return this.serial(async () => {
      if (!input || Object.keys(input).some(key => !['paused', 'scope'].includes(key))) throw new Error('Invalid collector settings');
      const current = await this.settings(), next = { ...current, ...input };
      if (typeof next.paused !== 'boolean') throw new Error('Invalid collector pause state');
      if (next.scope !== null) this.validateScope(next.scope);
      if (!next.paused && (!this.config.collectorGatesVerified || !this.config.boxesRunUrl || !this.config.boxesSecret || !this.config.boxesThreadId || !next.scope)) throw new Error('Invalid collector activation: live pilot, mutation guard, upload isolation and restore gates must be verified first');
      await atomicJSON(join(this.root, 'schedule.json'), next);
      return next;
    });
  }
  validateScope(scope) {
    validateEvidenceScope(scope);
    if (scope.league_id !== this.config.leagueId || scope.dataset !== 'team_roster' || !scope.team_id) throw new Error('Invalid collector scope: this release accepts one configured league roster');
    validateIdentifier(scope.team_id, 'collector team ID');
  }
  async create({ scope, intended_for = new Date(this.now()).toISOString() }) {
    this.validateScope(scope); validateTimestamp(intended_for, 'collection slot');
    intended_for = new Date(intended_for).toISOString();
    const allowed_pages = rosterAllowedPages(scope);
    const key = canonicalDigest({ scope, allowed_pages, intended_for });
    const id = `run-${key.slice(0, 32)}`;
    try { return await this.store.read(id, 'runs'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const input = { id, job_id: 'bounded-roster', idempotency_key: key, scope, allowed_pages, intended_for, created_at: new Date(this.now()).toISOString(), automation_id: this.config.boxesAutomationId || null, thread_id: this.config.boxesThreadId || null, budget: { unit: 'seconds', limit: 600 } };
    return this.store.saveRun(input);
  }
  async status() {
    const settings = await this.settings();
    const attempts = (await this.store.list('attempts')).filter(a => a.id.startsWith('collector-'));
    return { ...settings, trigger_configured: Boolean(this.config.boxesRunUrl && this.config.boxesSecret && this.config.boxesThreadId), gates_verified: Boolean(this.config.collectorGatesVerified), attempts: attempts.slice(0, 20), alerts: attempts.filter(a => !['complete', 'partial'].includes(a.outcome)).slice(0, 10) };
  }
  async dispatch(run) {
    if (!this.config.collectorGatesVerified) throw new Error('Invalid collector trigger: external gates are unverified; use supervised upload');
    if (!this.config.boxesRunUrl || !this.config.boxesSecret || !run.thread_id) throw new Error('Invalid collector trigger configuration');
    // Only identifiers and bounded scope go to the model. An isolated broker handles upload capabilities.
    const input = { prompt: `Perform the observation-only collector contract in prompts/collector-readonly.md. Produce the complete ingest-ready artifact bundle described there for run ${run.id}, idempotency key ${run.idempotency_key}. Scope: ${JSON.stringify(run.scope)}. Exact allowed_pages: ${JSON.stringify(run.allowed_pages)}. Do not upload, access credentials, or change Yahoo state.`, target: { kind: 'existing_thread', threadId: run.thread_id } };
    const started = new Date(this.now()).toISOString();
    const attemptId = `collector-${randomUUID()}`;
    try {
      const response = await this.fetcher(this.config.boxesRunUrl, { method: 'POST', headers: { Authorization: `Bearer ${this.config.boxesSecret}`, 'Content-Type': 'application/json', 'Idempotency-Key': run.idempotency_key }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000), redirect: 'error' });
      if (response.status !== 202) throw new Error('Trigger refused');
      const result = await response.json();
      if (!['starting', 'thread_ready'].includes(result.status)) throw new Error('Trigger failed');
      const receipt = { run_id: run.id, accepted_at: started, deadline: new Date(this.now() + 15 * 60_000).toISOString(), status: 'awaiting_artifacts' };
      await atomicJSON(join(this.root, `${run.id}.json`), receipt);
      return receipt;
    } catch {
      return this.store.saveRunAttempt({ id: attemptId, run_id: run.id, started_at: started, finished_at: new Date(this.now()).toISOString(), outcome: 'failed', artifact_ids: [], reason: 'Automation trigger failed or budget/capacity unavailable; retry the same logical run after checking boxes.dev.' });
    }
  }
  async runNow(input = {}) {
    return this.serial(async () => {
      const settings = await this.settings();
      const run = await this.create({ scope: input.scope || settings.scope, intended_for: input.intended_for });
      return { run, ...(input.dispatch === true ? { launch: await this.dispatch(run) } : { launch: { status: 'supervised_upload', detail: 'No external automation was started' } }) };
    });
  }
  async tick() {
    return this.serial(async () => {
      const settings = await this.settings();
      await this.expirePending();
      if (settings.paused || !this.config.collectorGatesVerified || Date.parse(settings.next_run) > this.now()) return null;
      // After downtime, catch up only the most recent slot, never replay every missed slot.
      const slot = collectionSlot(this.now());
      const run = await this.create({ scope: settings.scope, intended_for: slot });
      const result = await this.dispatch(run);
      await atomicJSON(join(this.root, 'schedule.json'), { ...settings, last_slot: slot, next_run: nextCollectionSlot(this.now()) });
      return result;
    });
  }
  async expirePending() {
    const runs = await this.store.list('runs');
    const attempts = await this.store.list('attempts');
    const settledRuns = new Set(attempts.filter(attempt => attempt.artifact_ids.length > 0 || attempt.outcome === 'timed_out').map(attempt => attempt.run_id));
    for (const run of runs) {
      if (settledRuns.has(run.id)) continue;
      let pending;
      try { pending = JSON.parse(await readFile(join(this.root, `${run.id}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (Date.parse(pending.deadline) > this.now()) continue;
      await this.store.saveRunAttempt({ id: `collector-timeout-${run.id.slice(4)}`, run_id: run.id, started_at: pending.accepted_at, finished_at: pending.deadline, outcome: 'timed_out', artifact_ids: [], reason: 'No verified collector output arrived before the deadline. Check login, capacity and model budget.' });
    }
  }
}
