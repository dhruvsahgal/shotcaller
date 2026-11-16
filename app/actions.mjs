import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicJSON, canonicalDigest } from './store.mjs';
import { actionClasses, signAuthorization, verifyAuthorization } from './permissions.mjs';
import { strictInstant } from './time.mjs';
import { isPlainObject } from './value.mjs';

const exact = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const playerIds = operation => [operation.player_id, operation.add_player_id, operation.drop_player_id].filter(Boolean);
const ilSlot = slot => typeof slot === 'string' && slot.startsWith('IL');
const readbackFields = input => ({ outcome: input.outcome, before_evidence_ids: input.before_evidence_ids, after_evidence_ids: input.after_evidence_ids, visible_state: input.visible_state });
const proposalFields = ['version', 'action_class', 'league_id', 'scoring_date', 'expires_at', 'operation', 'preconditions', 'source_snapshot_ids'];
const terminalActionOutcomes = new Set(['applied', 'blocked', 'shadowed']);

export const actionAttemptTransitions = Object.freeze({
  proposed: Object.freeze(['blocked', 'shadowed', 'preflight_passed']),
  preflight_passed: Object.freeze(['blocked', 'prepared']),
  blocked: Object.freeze([]),
  shadowed: Object.freeze([]),
  prepared: Object.freeze([])
});

export const actionOutcomeTransitions = Object.freeze({
  prepared: Object.freeze(['applied', 'blocked', 'ambiguous', 'partial']),
  shadowed: Object.freeze(['shadowed']),
  ambiguous: Object.freeze(['applied', 'blocked', 'ambiguous', 'partial']),
  partial: Object.freeze(['applied', 'blocked', 'ambiguous', 'partial']),
  applied: Object.freeze([]),
  blocked: Object.freeze([])
});

function assertTransition(map, from, to) {
  if (!map[from]?.includes(to)) throw new Error(`Forbidden action transition: ${from} -> ${to}`);
}

export function validateActionProposal(input, now = Date.now()) {
  if (!(exact(input, proposalFields) || exact(input, [...proposalFields, 'decision_id']))) throw new Error('Invalid action proposal fields');
  if (input.version !== 1 || !actionClasses.includes(input.action_class) || !/^\d{1,12}$/.test(input.league_id) || !date(input.scoring_date) || !strictInstant(input.expires_at) || Date.parse(input.expires_at) <= now) throw new Error('Invalid action proposal scope or expiry');
  if (!Array.isArray(input.source_snapshot_ids) || !input.source_snapshot_ids.length || input.source_snapshot_ids.some(id => !identifier(id))) throw new Error('Invalid action proposal evidence');
  if (!input.preconditions || typeof input.preconditions !== 'object' || Array.isArray(input.preconditions)) throw new Error('Invalid action preconditions');
  if (Object.hasOwn(input, 'decision_id') && !(input.decision_id === null || identifier(input.decision_id))) throw new Error('Invalid action decision link');
  const operation = input.operation;
  if (input.action_class === 'lineup_move' && (!exact(operation, ['player_id', 'from_slot', 'to_slot']) || ![operation.player_id, operation.from_slot, operation.to_slot].every(identifier))) throw new Error('Invalid lineup move');
  if (input.action_class === 'il_move' && (!exact(operation, ['player_id', 'from_slot', 'to_slot']) || ![operation.player_id, operation.from_slot, operation.to_slot].every(identifier) || ilSlot(operation.from_slot) === ilSlot(operation.to_slot))) throw new Error('Invalid IL move');
  if (input.action_class === 'add_drop' && (!exact(operation, ['add_player_id', 'drop_player_id']) || !identifier(operation.add_player_id) || !(operation.drop_player_id === null || identifier(operation.drop_player_id)))) throw new Error('Invalid add/drop');
  if (input.action_class === 'trade_response' && (!exact(operation, ['offer_id', 'response']) || !identifier(operation.offer_id) || !['accept', 'reject'].includes(operation.response))) throw new Error('Invalid trade response');
  return structuredClone(input);
}

export function preflightAction(intent, state, control = {}, now = Date.now()) {
  const reasons = [];
  if (control.stop_switch) reasons.push('The action stop switch is active.');
  if (control.human_takeover) reasons.push('Human takeover is active.');
  if (Date.parse(intent.expires_at) <= now) reasons.push('The proposed action expired.');
  if (String(state?.league_id) !== String(intent.league_id)) reasons.push('The visible league does not match the authorized league.');
  if (state?.scoring_date !== intent.scoring_date) reasons.push('The visible scoring date does not match the authorized date.');
  const started = new Set(state?.started_player_ids || []), locked = new Set(state?.locked_player_ids || []), roster = new Set(state?.roster_player_ids || []);
  for (const id of playerIds(intent.operation)) if (started.has(id) || locked.has(id)) reasons.push(`Player ${id} has started or locked.`);
  const operation = intent.operation;
  if (intent.action_class === 'lineup_move') {
    if (!roster.has(operation.player_id)) reasons.push('The lineup player is no longer rostered.');
    if (state?.slots?.[operation.player_id] !== operation.from_slot) reasons.push('The lineup source slot changed.');
    if (!(state?.eligible_slots?.[operation.player_id] || []).includes(operation.to_slot)) reasons.push('The destination slot is not currently eligible.');
  }
  if (intent.action_class === 'il_move') {
    if (!roster.has(operation.player_id) || state?.slots?.[operation.player_id] !== operation.from_slot) reasons.push('The IL player or source slot changed.');
    if (ilSlot(operation.to_slot)) {
      if (!state?.injury_eligible_player_ids?.includes(operation.player_id)) reasons.push('The player is not currently IL eligible.');
      if ((state?.open_il_slots ?? 0) < 1) reasons.push('No IL slot is open.');
    } else {
      if (operation.to_slot !== 'BN' && !(state?.eligible_slots?.[operation.player_id] || []).includes(operation.to_slot)) reasons.push('The active destination slot is not currently eligible.');
      if ((state?.open_active_slots ?? 0) < 1) reasons.push('No active roster slot is open for IL activation.');
    }
  }
  if (intent.action_class === 'add_drop') {
    if (!state?.available_player_ids?.includes(operation.add_player_id)) reasons.push('The add candidate is no longer available.');
    if (operation.drop_player_id && !roster.has(operation.drop_player_id)) reasons.push('The drop player is no longer rostered.');
    if ((state?.acquisitions_used ?? 0) >= (state?.acquisitions_allowed ?? 0)) reasons.push('The weekly acquisition limit is exhausted.');
    const afterDrop = roster.size - (operation.drop_player_id ? 1 : 0);
    if (afterDrop >= (state?.max_roster_size ?? 0)) reasons.push('No legal roster capacity remains.');
  }
  if (intent.action_class === 'trade_response') {
    if (state?.visible_offer_id !== operation.offer_id) reasons.push('The visible trade offer does not match the authorized offer.');
    if (!state?.offer_open) reasons.push('The authorized trade offer is no longer open.');
  }
  for (const [key, expected] of Object.entries(intent.preconditions)) if (state?.preconditions?.[key] !== expected) reasons.push(`Precondition ${key} changed.`);
  return { allowed: reasons.length === 0, reasons, checked_at: new Date(now).toISOString() };
}

export class ActionService {
  constructor(config, store, { now = () => Date.now(), fetcher = fetch, evidenceValidator = null } = {}) { this.config = config; this.store = store; this.now = now; this.fetcher = fetcher; this.evidenceValidator = evidenceValidator; this.root = join(config.dataDir, 'actions'); this.queue = Promise.resolve(); }
  async init() { await Promise.all([mkdir(join(this.root, 'consumed'), { recursive: true, mode: 0o700 }), mkdir(join(this.config.dataDir, 'action-reconciliations'), { recursive: true, mode: 0o700 })]); }
  serial(operation) { const pending = this.queue.then(operation, operation); this.queue = pending.catch(() => {}); return pending; }
  liveConfigurationAllows(intent) {
    return intent.execution_mode === 'live' && this.config.actionMode === 'live' && this.config.actionGatesVerified === true && this.config.actionEnabledClasses.includes(intent.action_class);
  }
  assertLiveConfiguration(intent) {
    if (!this.liveConfigurationAllows(intent)) throw new Error('Live action mode, promotion gates, or enabled class changed');
  }
  async validateEvidence(ids, phase, intentId, attemptId = null) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !identifier(id)) || new Set(ids).size !== ids.length) throw new Error(`Invalid ${phase} action evidence`);
    if (this.evidenceValidator) await this.evidenceValidator({ ids: [...ids], phase, intent_id: intentId, attempt_id: attemptId });
    return [...ids];
  }
  validateFreshObservation(observedAt) {
    if (!strictInstant(observedAt)) throw new Error('Invalid action observation time');
    const age = this.now() - Date.parse(observedAt);
    const maxAge = this.config.actionMaxObservationAgeMs ?? 120_000;
    if (age < 0 || age > maxAge) throw new Error('Action state evidence is stale or from the future');
    return observedAt;
  }
  async attemptSuccessor(attemptId) {
    const rows = (await this.store.list('action-attempts')).filter(row => row.previous_attempt_id === attemptId);
    if (rows.length > 1) throw new Error('Action attempt has conflicting transitions');
    return rows[0] || null;
  }
  async saveEvidence(id, input) {
    if (!exact(input, ['phase', 'attempt_id', 'observed_at', 'media_type', 'sha256', 'content_base64']) || !['before', 'after'].includes(input.phase) || !(input.attempt_id === null || identifier(input.attempt_id)) || !strictInstant(input.observed_at) || !['application/json', 'text/plain', 'image/png', 'image/jpeg'].includes(input.media_type) || !/^[a-f0-9]{64}$/.test(input.sha256) || typeof input.content_base64 !== 'string') throw new Error('Invalid action evidence upload');
    const intent = await this.store.read(id, 'action-intents');
    if (input.attempt_id) {
      const attempt = await this.store.read(input.attempt_id, 'action-attempts');
      if (attempt.intent_id !== id) throw new Error('Invalid action evidence attempt binding');
    }
    const content = Buffer.from(input.content_base64, 'base64');
    if (!content.length || content.length > 1_048_576 || content.toString('base64') !== input.content_base64 || createHash('sha256').update(content).digest('hex') !== input.sha256) throw new Error('Invalid action evidence content');
    const identity = { intent_id: intent.id, attempt_id: input.attempt_id, phase: input.phase, observed_at: input.observed_at, media_type: input.media_type, bytes: content.length, sha256: input.sha256 };
    const recordId = `action-evidence-${canonicalDigest(identity).slice(0, 32)}`;
    try { return await this.store.read(recordId, 'action-evidence'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const record = { schema_version: 1, kind: 'action_evidence', id: recordId, ...identity, stored_at: new Date(this.now()).toISOString(), content_base64: input.content_base64 };
    record.content_hash = canonicalDigest(record);
    return this.store.publish(record, 'action-evidence');
  }
  async control() {
    try { return JSON.parse(await readFile(join(this.root, 'control.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { stop_switch: true, human_takeover: false, updated_at: null }; throw error; }
  }
  async setControl(input) {
    if (!exact(input, ['stop_switch', 'human_takeover']) || typeof input.stop_switch !== 'boolean' || typeof input.human_takeover !== 'boolean') throw new Error('Invalid action control state');
    await this.init(); const value = { ...input, updated_at: new Date(this.now()).toISOString() }; await atomicJSON(join(this.root, 'control.json'), value); return value;
  }
  async propose(raw) {
    const input = validateActionProposal(raw, this.now());
    if (input.league_id !== this.config.leagueId) throw new Error('Action league does not match this ShotCaller instance');
    const mode = this.config.actionMode === 'live' && this.config.actionGatesVerified && this.config.actionEnabledClasses.includes(input.action_class) ? 'live' : 'shadow';
    const createdAt = new Date(this.now()).toISOString();
    const base = { schema_version: 1, kind: 'action_intent', action_class: input.action_class, league_id: input.league_id, scoring_date: input.scoring_date, expires_at: input.expires_at, operation: input.operation, preconditions: input.preconditions, source_snapshot_ids: [...new Set(input.source_snapshot_ids)].sort(), decision_id: input.decision_id || null, execution_mode: mode, created_at: createdAt, stored_at: createdAt };
    const intentDigest = canonicalDigest(base), id = `action-${intentDigest.slice(0, 32)}`;
    await this.validateEvidence(base.source_snapshot_ids, 'source', id);
    return this.store.publish({ ...base, id, intent_digest: intentDigest, content_hash: intentDigest }, 'action-intents');
  }
  async authorize(id, input) {
    return this.serial(async () => {
      const intent = await this.store.read(id, 'action-intents');
      if (intent.execution_mode === 'live' && !this.liveConfigurationAllows(intent)) throw new Error('Live action class has not passed its promotion gates');
      const authorization = signAuthorization(intent, { ...input, authorized_at: new Date(this.now()).toISOString() }, this.config.actionSigningKey);
      const record = { schema_version: 1, kind: 'action_authorization', id: `authorization-${id.slice(7)}`, intent_id: id, stored_at: new Date(this.now()).toISOString(), authorization };
      record.content_hash = canonicalDigest(authorization);
      return this.store.publish(record, 'action-authorizations');
    });
  }
  async package(id) {
    const [intent, record, control] = await Promise.all([this.store.read(id, 'action-intents'), this.store.read(`authorization-${id.slice(7)}`, 'action-authorizations'), this.control()]);
    verifyAuthorization(record.authorization, intent, this.config.actionSigningKey, this.now());
    return { intent, authorization: record.authorization, control };
  }
  async prepare(id, input) {
    return this.serial(async () => {
      const readbacks = [...await this.store.list('action-outcomes'), ...await this.store.list('action-reconciliations')];
      if (readbacks.some(row => row.intent_id === id && terminalActionOutcomes.has(row.outcome))) throw new Error('Action intent already has a terminal outcome');
      const { intent, authorization, control } = await this.package(id);
      const evidence = await this.validateEvidence(input.before_evidence_ids, 'before', id);
      const preflight = preflightAction(intent, input.state, control, this.now());
      const status = !preflight.allowed ? 'blocked' : intent.execution_mode === 'shadow' ? 'shadowed' : 'preflight_passed';
      assertTransition(actionAttemptTransitions, 'proposed', status);
      return this.receipt(intent, authorization, status, preflight, evidence);
    });
  }
  async arm(id, input) {
    return this.serial(async () => {
      if (!exact(input, ['attempt_id', 'state', 'before_evidence_ids', 'observed_at']) || !isPlainObject(input.state)) throw new Error('Invalid action arm request');
      const { intent, authorization, control } = await this.package(id);
      this.assertLiveConfiguration(intent);
      const attempt = await this.store.read(input.attempt_id, 'action-attempts');
      if (attempt.intent_id !== id || attempt.status !== 'preflight_passed') throw new Error('Action has not passed a live preflight');
      const successor = await this.attemptSuccessor(attempt.id);
      if (successor) return successor.status === 'prepared' ? { status: 'reconcile_required', intent_id: id, reason: 'This preflight already armed a mutation; reconcile Yahoo state before any retry.' } : successor;
      const observedAt = this.validateFreshObservation(input.observed_at);
      const evidence = await this.validateEvidence(input.before_evidence_ids, 'arm', id, input.attempt_id);
      const preflight = { ...preflightAction(intent, input.state, control, this.now()), state_observed_at: observedAt };
      if (!preflight.allowed) {
        assertTransition(actionAttemptTransitions, attempt.status, 'blocked');
        return this.receipt(intent, authorization, 'blocked', preflight, evidence, attempt.id, observedAt);
      }
      await this.init();
      const nonceFile = join(this.root, 'consumed', `${authorization.nonce}.json`);
      try {
        const handle = await open(nonceFile, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ intent_id: id, digest: authorization.digest, consumed_at: new Date(this.now()).toISOString() })); await handle.sync(); }
        finally { await handle.close(); }
      } catch (error) {
        if (error.code === 'EEXIST') return { status: 'reconcile_required', intent_id: id, reason: 'Authorization nonce was already consumed; read Yahoo state before any retry.' };
        throw error;
      }
      assertTransition(actionAttemptTransitions, attempt.status, 'prepared');
      return this.receipt(intent, authorization, 'prepared', preflight, evidence, attempt.id, observedAt);
    });
  }
  async receipt(intent, authorization, status, preflight, evidenceIds, previousAttemptId = null, evidenceObservedAt = null) {
    const id = `action-attempt-${randomUUID()}`;
    const createdAt = new Date(this.now()).toISOString();
    const value = { schema_version: 1, kind: 'action_attempt', id, intent_id: intent.id, authorization_digest: authorization.digest, execution_mode: intent.execution_mode, status, preflight, before_evidence_ids: evidenceIds, after_evidence_ids: [], previous_attempt_id: previousAttemptId, evidence_observed_at: evidenceObservedAt, created_at: createdAt, stored_at: createdAt, requires_reconciliation: status === 'prepared' };
    value.content_hash = canonicalDigest(value);
    return this.store.publish(value, 'action-attempts');
  }
  async latestReadback(attemptId) {
    let outcome = null;
    try { outcome = await this.store.read(`outcome-${attemptId}`, 'action-outcomes'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!outcome) return null;
    await this.init();
    const rows = (await this.store.list('action-reconciliations')).filter(row => row.attempt_id === attemptId);
    rows.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.id.localeCompare(b.id));
    return rows.at(-1) || outcome;
  }
  async readback(id, input) {
    return this.serial(async () => {
      if (!exact(input, ['attempt_id', 'outcome', 'before_evidence_ids', 'after_evidence_ids', 'visible_state']) || !['applied', 'blocked', 'ambiguous', 'partial', 'shadowed'].includes(input.outcome) || !Array.isArray(input.before_evidence_ids) || !Array.isArray(input.after_evidence_ids)) throw new Error('Invalid action readback');
      const [intent, attempt] = await Promise.all([this.store.read(id, 'action-intents'), this.store.read(input.attempt_id, 'action-attempts')]);
      if (attempt.intent_id !== id) throw new Error('Invalid action attempt binding');
      const beforeEvidence = await this.validateEvidence(input.before_evidence_ids, 'readback-before', id, input.attempt_id);
      const afterEvidence = await this.validateEvidence(input.after_evidence_ids, 'readback-after', id, input.attempt_id);
      const readbackDigest = canonicalDigest(readbackFields({ ...input, before_evidence_ids: beforeEvidence, after_evidence_ids: afterEvidence }));
      const previous = await this.latestReadback(input.attempt_id);
      if (previous?.readback_digest === readbackDigest) return previous;
      const from = previous?.outcome || attempt.status;
      assertTransition(actionOutcomeTransitions, from, input.outcome);
      const recordedAt = new Date(this.now()).toISOString();
      const reconciliation = Boolean(previous);
      const value = { schema_version: 1, kind: reconciliation ? 'action_reconciliation' : 'action_outcome', id: reconciliation ? `reconciliation-${canonicalDigest({ attempt_id: input.attempt_id, previous_id: previous.id, readback_digest: readbackDigest }).slice(0, 32)}` : `outcome-${input.attempt_id}`, intent_id: id, attempt_id: input.attempt_id, previous_record_id: previous?.id || null, action_class: intent.action_class, execution_mode: intent.execution_mode, outcome: input.outcome, before_evidence_ids: beforeEvidence, after_evidence_ids: afterEvidence, visible_state: input.visible_state, readback_digest: readbackDigest, recorded_at: recordedAt, stored_at: recordedAt, requires_reconciliation: ['ambiguous', 'partial'].includes(input.outcome) };
      value.content_hash = canonicalDigest(value);
      return this.store.publish(value, reconciliation ? 'action-reconciliations' : 'action-outcomes');
    });
  }
  async dispatch(id) {
    const { intent, control } = await this.package(id);
    if (control.stop_switch || control.human_takeover) throw new Error('Action dispatch is stopped');
    this.assertLiveConfiguration(intent);
    if (!this.config.boxesRunUrl || !this.config.boxesSecret || !this.config.boxesExecutorThreadId) throw new Error('Action executor gates or isolated thread are unavailable');
    const response = await this.fetcher(this.config.boxesRunUrl, { method: 'POST', headers: { Authorization: `Bearer ${this.config.boxesSecret}`, 'Content-Type': 'application/json', 'Idempotency-Key': intent.intent_digest }, body: JSON.stringify({ prompt: `Process ShotCaller intent ${intent.id} using prompts/executor-bounded.md.`, target: { kind: 'existing_thread', threadId: this.config.boxesExecutorThreadId } }), signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (response.status !== 202) throw new Error('Action executor trigger refused');
    const result = await response.json();
    if (!['starting', 'thread_ready'].includes(result.status)) throw new Error('Action executor trigger failed');
    return { intent_id: id, status: 'accepted', execution_mode: intent.execution_mode };
  }
  async status({ limit = 10 } = {}) {
    await this.init();
    const [intents, authorizations, attempts, outcomes, reconciliations, control] = await Promise.all([this.store.recent('action-intents', limit), ...['action-authorizations', 'action-attempts', 'action-outcomes', 'action-reconciliations'].map(folder => this.store.list(folder)), this.control()]);
    const lifecycle = [...authorizations.map(row => ({ ...row, lifecycle_status: 'authorized', lifecycle_phase: 1, lifecycle_terminal: false })), ...attempts.map(row => ({ ...row, lifecycle_status: row.status, lifecycle_phase: 2, lifecycle_terminal: false })), ...outcomes.map(row => ({ ...row, lifecycle_status: row.outcome, lifecycle_phase: 3, lifecycle_terminal: terminalActionOutcomes.has(row.outcome) })), ...reconciliations.map(row => ({ ...row, lifecycle_status: row.outcome, lifecycle_phase: 4, lifecycle_terminal: terminalActionOutcomes.has(row.outcome) }))];
    const timestamp = row => String(row.recorded_at ?? row.stored_at ?? row.created_at ?? '');
    lifecycle.sort((a, b) => Number(b.lifecycle_terminal) - Number(a.lifecycle_terminal) || timestamp(b).localeCompare(timestamp(a)) || b.lifecycle_phase - a.lifecycle_phase || b.id.localeCompare(a.id));
    const latestByIntent = new Map();
    for (const row of lifecycle) if (!latestByIntent.has(row.intent_id)) latestByIntent.set(row.intent_id, row.lifecycle_status);
    const currentIntents = intents.map(intent => ({ ...intent, current_status: latestByIntent.get(intent.id) || 'proposed' }));
    return { mode: this.config.actionMode, gates_verified: this.config.actionGatesVerified, enabled_classes: this.config.actionEnabledClasses, control, intents: currentIntents, authorizations: authorizations.slice(0, limit).map(row => ({ id: row.id, intent_id: row.intent_id, stored_at: row.stored_at })), attempts: attempts.slice(0, limit), outcomes: outcomes.slice(0, limit), reconciliations: reconciliations.slice(0, limit) };
  }
}
