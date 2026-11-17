import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON, canonicalDigest } from './store.mjs';
import { validateEvidenceScope, validateIdentifier, validateTimestamp } from './schema.mjs';
import { validateCollectorAllowedPages, validateCollectorRequest } from '../scripts/validate-collector-output.mjs';
import { createCoveragePlan } from './coverage.mjs';

const interval = 24 * 60 * 60_000;
const firstSlot = Date.parse('2000-01-01T16:00:00+08:00');
const settledOutcomes = new Set(['complete', 'partial', 'failed', 'cancelled', 'needs_login']);
function receiptSettled(receipt, attempts, runId) {
  if (!receipt.attempt_id) return attempts.some(attempt => attempt.run_id === runId && settledOutcomes.has(attempt.outcome) && Date.parse(attempt.finished_at) >= Date.parse(receipt.accepted_at));
  const bound = new Set([receipt.attempt_id, receipt.reconciliation_attempt_id].filter(Boolean));
  return attempts.some(attempt => attempt.run_id === runId && bound.has(attempt.id) && settledOutcomes.has(attempt.outcome));
}
export function collectionSlot(now = Date.now()) {
  return new Date(firstSlot + Math.floor((now - firstSlot) / interval) * interval).toISOString();
}
export function nextCollectionSlot(now = Date.now()) { return new Date(Date.parse(collectionSlot(now)) + interval).toISOString(); }
export function rosterAllowedPages(scope) {
  const page = `https://basketball.fantasysports.yahoo.com/nba/${scope.league_id}/${scope.team_id}`;
  if (!validateCollectorRequest({ method: 'GET', url: page, allowedPages: [page] }).allowed) throw new Error('Invalid collector roster page');
  return [page];
}

export function fullLeagueAllowedPages(plan) {
  validateIdentifier(plan.league_id, 'collector league ID');
  plan.team_ids.forEach(teamId => validateIdentifier(teamId, 'collector team ID'));
  plan.matchups.forEach(matchup => validateIdentifier(matchup.id, 'collector matchup ID'));
  const base = `https://basketball.fantasysports.yahoo.com/nba/${encodeURIComponent(plan.league_id)}`;
  const pages = [base, `${base}/settings`, `${base}/matchup`, `${base}/teamstats`, `${base}/transactions`, `${base}/players?status=FA`, `${base}/players?status=W`];
  for (const matchup of plan.matchups) pages.push(`${base}/matchup?week=${encodeURIComponent(plan.scoring_period.key)}&module=matchup&mid1=${encodeURIComponent([...matchup.team_ids].sort()[0])}`);
  for (const teamId of plan.team_ids) {
    const encodedTeamId = encodeURIComponent(teamId);
    pages.push(`${base}/${encodedTeamId}`);
    for (const date of plan.scoring_dates) pages.push(`${base}/${encodedTeamId}?date=${date}`);
  }
  for (let page = 0; page < 40; page += 1) {
    const count = page * 25;
    pages.push(`${base}/players?count=${count}&status=FA`, `${base}/players?count=${count}&status=W`, `${base}/transactions?count=${count}`);
  }
  const unique = [...new Set(pages)];
  if (!validateCollectorAllowedPages(unique)) throw new Error('Invalid full-league collector page');
  return unique;
}

function coverageScope(plan) {
  return { dataset: 'league_coverage', league_id: plan.league_id, season: plan.season, team_id: null, matchup_id: null, scoring_period: structuredClone(plan.scoring_period), value_basis: { value: 'actual', aggregation: 'snapshot' } };
}

function dispatchPrompt(run, attemptId) {
  if (!run.collection_plan) return `Perform the observation-only collector contract in prompts/collector-readonly.md. Produce the complete ingest-ready artifact bundle described there for run ${run.id}, attempt ${attemptId}, idempotency key ${run.idempotency_key}. Scope: ${JSON.stringify(run.scope)}. Exact allowed_pages: ${JSON.stringify(run.allowed_pages)}. Do not upload, access credentials, or change Yahoo state.`;
  return `Perform the observation-only collector contract in prompts/collector-readonly.md. Produce the complete ingest-ready artifact bundle described there for run ${run.id}, attempt ${attemptId}.

Write this exact immutable Railway run object to data/pilot/run.json before collecting; do not alter, regenerate, or summarize it:
${JSON.stringify(run)}

After the bundle and manifest are complete, run:
npm run validate:league-bundle -- data/pilot/run.json data/pilot/manifest.json data/pilot
Only after that succeeds, invoke the trusted uploader exactly once:
npm run upload:league-bundle -- data/pilot/run.json data/pilot/manifest.json data/pilot
The uploader reads SHOTCALLER_URL and COLLECTOR_TOKEN from the trusted environment. Do not inspect, print, copy, log, or place either value in chat or files. Do not upload by any other mechanism. Return the compact Railway readback receipt, coverage gaps, and evidence paths. A failed validation, upload, or readback is partial or failed and must not be retried by broadening scope. Never change Yahoo state.`;
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
  gatesVerified(plan = null) {
    return Boolean(this.config.collectorGatesVerified && (!plan || this.config.fullLeagueCollectorGatesVerified));
  }
  async settings() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { return JSON.parse(await readFile(join(this.root, 'schedule.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const initial = { version: 1, timezone: 'Asia/Singapore', times: ['16:00'], paused: true, scope: null, next_run: nextCollectionSlot(this.now()), last_slot: null };
      await atomicJSON(join(this.root, 'schedule.json'), initial);
      return initial;
    }
  }
  async configure(input) {
    return this.serial(async () => {
      if (!input || Object.keys(input).some(key => !['paused', 'scope', 'plan'].includes(key))) throw new Error('Invalid collector settings');
      const current = await this.settings(), next = { ...current, ...input };
      if (typeof next.paused !== 'boolean') throw new Error('Invalid collector pause state');
      if (next.scope !== null) this.validateScope(next.scope);
      if (next.plan != null) next.plan = this.validatePlan(next.plan);
      if (next.scope && next.plan) throw new Error('Invalid collector settings: choose one roster scope or one league plan');
      if (!next.paused && (!this.gatesVerified(next.plan) || !this.config.boxesRunUrl || !this.config.boxesSecret || !this.config.boxesThreadId || (!next.scope && !next.plan))) throw new Error('Invalid collector activation: live pilot, mutation guard, upload isolation and restore gates must be verified first');
      await atomicJSON(join(this.root, 'schedule.json'), next);
      return next;
    });
  }
  validateScope(scope) {
    validateEvidenceScope(scope);
    if (scope.league_id !== this.config.leagueId || scope.dataset !== 'team_roster' || !scope.team_id) throw new Error('Invalid collector scope: this release accepts one configured league roster');
    validateIdentifier(scope.team_id, 'collector team ID');
  }
  validatePlan(input) {
    const plan = createCoveragePlan(input);
    if (plan.league_id !== this.config.leagueId || plan.team_ids.length !== this.config.expectedTeams) throw new Error('Invalid collector plan: league or team count does not match this ShotCaller instance');
    return plan;
  }
  async create({ scope = null, plan: planInput = null, intended_for = new Date(this.now()).toISOString() }) {
    if (Boolean(scope) === Boolean(planInput)) throw new Error('Invalid collector request: choose one roster scope or one league plan');
    const plan = planInput ? this.validatePlan(planInput) : null;
    if (!plan) this.validateScope(scope);
    else scope = coverageScope(plan);
    validateTimestamp(intended_for, 'collection slot');
    intended_for = new Date(intended_for).toISOString();
    const allowed_pages = plan ? fullLeagueAllowedPages(plan) : rosterAllowedPages(scope);
    const key = canonicalDigest(plan ? { scope, collection_plan: plan, allowed_pages, intended_for } : { scope, allowed_pages, intended_for });
    const id = `run-${key.slice(0, 32)}`;
    try { return await this.store.read(id, 'runs'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const input = { id, job_id: plan ? 'full-league-collector' : 'bounded-roster', idempotency_key: key, scope, ...(plan ? { collection_plan: plan } : {}), allowed_pages, intended_for, created_at: new Date(this.now()).toISOString(), automation_id: this.config.boxesAutomationId || null, thread_id: this.config.boxesThreadId || null, budget: { unit: 'seconds', limit: plan ? 3600 : 600 } };
    return this.store.saveRun(input);
  }
  async status() {
    const [settings, allAttempts, runs] = await Promise.all([this.settings(), this.store.list('attempts'), this.store.list('runs')]);
    const attempts = allAttempts.filter(a => a.id.startsWith('collector-'));
    const unresolved = await this.unresolvedReceipt(allAttempts, runs);
    return { ...settings, trigger_configured: Boolean(this.config.boxesRunUrl && this.config.boxesSecret && this.config.boxesThreadId), gates_verified: this.gatesVerified(settings.plan), roster_gates_verified: Boolean(this.config.collectorGatesVerified), full_league_gates_verified: Boolean(this.config.fullLeagueCollectorGatesVerified), unresolved_run: unresolved ? { run_id: unresolved.run.id, status: unresolved.receipt.status, deadline: unresolved.receipt.deadline } : null, attempts: attempts.slice(0, 20), alerts: attempts.filter(a => !['complete', 'partial'].includes(a.outcome)).slice(0, 10) };
  }
  async unresolvedReceipt(attempts = null, runs = null) {
    [attempts, runs] = await Promise.all([attempts || this.store.list('attempts'), runs || this.store.list('runs')]);
    for (const run of runs) {
      try {
        const receipt = JSON.parse(await readFile(join(this.root, `${run.id}.json`), 'utf8'));
        if (receiptSettled(receipt, attempts, run.id)) continue;
        return { run, receipt };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return null;
  }
  async dispatch(run) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!this.gatesVerified(run.collection_plan)) throw new Error('Invalid collector trigger: external gates are unverified; use supervised upload');
    if (!this.config.boxesRunUrl || !this.config.boxesSecret || !run.thread_id) throw new Error('Invalid collector trigger configuration');
    const unresolved = await this.unresolvedReceipt();
    if (unresolved) throw new Error(`Collector run ${unresolved.run.id} must reconcile before launching a replacement`);
    const started = new Date(this.now()).toISOString();
    const attemptId = `collector-${randomUUID()}`;
    const receiptPath = join(this.root, `${run.id}.json`);
    const collectionDeadlineMs = Math.max(15 * 60_000, run.budget.limit * 1000 + 5 * 60_000);
    const dispatching = {
      version: 2,
      run_id: run.id,
      generation: attemptId,
      attempt_id: attemptId,
      dispatch_started_at: started,
      accepted_at: null,
      deadline: new Date(this.now() + collectionDeadlineMs).toISOString(),
      status: 'dispatching'
    };
    // This durable marker precedes the external request. A crash or transport error
    // therefore blocks a second launch until an operator reconciles this generation.
    await atomicJSON(receiptPath, dispatching);
    // Only identifiers and bounded scope go to the model. An isolated broker handles upload capabilities.
    const input = { prompt: dispatchPrompt(run, attemptId), target: { kind: 'existing_thread', threadId: run.thread_id } };
    let response;
    try {
      response = await this.fetcher(this.config.boxesRunUrl, { method: 'POST', headers: { Authorization: `Bearer ${this.config.boxesSecret}`, 'Content-Type': 'application/json', 'Idempotency-Key': run.idempotency_key }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000), redirect: 'error' });
    } catch {
      const ambiguous = { ...dispatching, status: 'reconciliation_required' };
      await atomicJSON(receiptPath, ambiguous);
      return ambiguous;
    }
    if (response.status !== 202) {
      const failed = await this.store.saveRunAttempt({ id: attemptId, run_id: run.id, started_at: started, finished_at: new Date(this.now()).toISOString(), outcome: 'failed', artifact_ids: [], reason: 'Automation trigger was refused before acceptance; retry may reuse this logical run.' });
      await atomicJSON(receiptPath, { ...dispatching, status: 'rejected' });
      return failed;
    }
    try {
      const result = await response.json();
      if (!['starting', 'thread_ready'].includes(result.status)) throw new Error('Trigger failed');
      const receipt = { ...dispatching, accepted_at: new Date(this.now()).toISOString(), status: 'awaiting_artifacts' };
      await atomicJSON(receiptPath, receipt);
      return receipt;
    } catch {
      const ambiguous = { ...dispatching, status: 'reconciliation_required' };
      await atomicJSON(receiptPath, ambiguous);
      return ambiguous;
    }
  }
  async runNow(input = {}) {
    return this.serial(async () => {
      const settings = await this.settings();
      const hasScope = Object.hasOwn(input, 'scope'), hasPlan = Object.hasOwn(input, 'plan');
      const run = await this.create({ scope: hasScope ? input.scope : hasPlan ? null : settings.scope, plan: hasPlan ? input.plan : hasScope ? null : settings.plan || null, intended_for: input.intended_for });
      return { run, ...(input.dispatch === true ? { launch: await this.dispatch(run) } : { launch: { status: 'supervised_upload', detail: 'No external automation was started' } }) };
    });
  }
  async tick() {
    return this.serial(async () => {
      const settings = await this.settings();
      await this.expirePending();
      if (settings.paused || !this.gatesVerified(settings.plan) || Date.parse(settings.next_run) > this.now()) return null;
      // After downtime, catch up only the most recent slot, never replay every missed slot.
      const slot = collectionSlot(this.now());
      const run = await this.create({ scope: settings.plan ? null : settings.scope, plan: settings.plan || null, intended_for: slot });
      const result = await this.dispatch(run);
      await atomicJSON(join(this.root, 'schedule.json'), { ...settings, last_slot: slot, next_run: nextCollectionSlot(this.now()) });
      return result;
    });
  }
  async expirePending() {
    const runs = await this.store.list('runs');
    const attempts = await this.store.list('attempts');
    for (const run of runs) {
      let pending;
      try { pending = JSON.parse(await readFile(join(this.root, `${run.id}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (receiptSettled(pending, attempts, run.id) || pending.status !== 'awaiting_artifacts') continue;
      if (Date.parse(pending.deadline) > this.now()) continue;
      await this.store.saveRunAttempt({ id: pending.attempt_id || `collector-timeout-${run.id.slice(4)}`, run_id: run.id, started_at: pending.accepted_at, finished_at: pending.deadline, outcome: 'timed_out', artifact_ids: [], reason: 'No verified collector output arrived before the deadline. Check login, capacity and model budget.' });
      await atomicJSON(join(this.root, `${run.id}.json`), { ...pending, status: 'reconciliation_required' });
    }
  }
  async reconcile(runId, { outcome, reason }) {
    if (!['failed', 'cancelled'].includes(outcome) || typeof reason !== 'string' || reason.trim().length < 12 || reason.length > 500) throw new Error('Invalid collector reconciliation');
    const run = await this.store.read(runId, 'runs');
    const unresolved = await this.unresolvedReceipt();
    if (!unresolved || unresolved.run.id !== run.id) throw new Error('Collector run does not require reconciliation');
    const receipt = unresolved.receipt;
    const attemptId = receipt.reconciliation_attempt_id || `collector-reconcile-${randomUUID()}`;
    await atomicJSON(join(this.root, `${run.id}.json`), { ...receipt, reconciliation_attempt_id: attemptId, status: 'reconciling' });
    return this.store.saveRunAttempt({ id: attemptId, run_id: run.id, started_at: receipt.dispatch_started_at || receipt.accepted_at, finished_at: new Date(this.now()).toISOString(), outcome, artifact_ids: [], reason: reason.trim() });
  }
}
