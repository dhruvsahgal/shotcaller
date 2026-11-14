import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON, canonicalDigest } from './store.mjs';
import { actionClasses, signAuthorization, verifyAuthorization } from './permissions.mjs';
import { strictInstant } from './time.mjs';
import { isPlainObject } from './value.mjs';

const exact = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const playerIds = operation => [operation.player_id, operation.add_player_id, operation.drop_player_id].filter(Boolean);

export function validateActionProposal(input, now = Date.now()) {
  if (!exact(input, ['version', 'action_class', 'league_id', 'scoring_date', 'expires_at', 'operation', 'preconditions', 'source_snapshot_ids'])) throw new Error('Invalid action proposal fields');
  if (input.version !== 1 || !actionClasses.includes(input.action_class) || !/^\d{1,12}$/.test(input.league_id) || !date(input.scoring_date) || !strictInstant(input.expires_at) || Date.parse(input.expires_at) <= now) throw new Error('Invalid action proposal scope or expiry');
  if (!Array.isArray(input.source_snapshot_ids) || !input.source_snapshot_ids.length || input.source_snapshot_ids.some(id => !identifier(id))) throw new Error('Invalid action proposal evidence');
  if (!input.preconditions || typeof input.preconditions !== 'object' || Array.isArray(input.preconditions)) throw new Error('Invalid action preconditions');
  const operation = input.operation;
  if (input.action_class === 'lineup_move' && (!exact(operation, ['player_id', 'from_slot', 'to_slot']) || ![operation.player_id, operation.from_slot, operation.to_slot].every(identifier))) throw new Error('Invalid lineup move');
  if (input.action_class === 'il_move' && (!exact(operation, ['player_id', 'from_slot', 'to_slot']) || ![operation.player_id, operation.from_slot, operation.to_slot].every(identifier))) throw new Error('Invalid IL move');
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
    if (!state?.injury_eligible_player_ids?.includes(operation.player_id)) reasons.push('The player is not currently IL eligible.');
    if ((state?.open_il_slots ?? 0) < 1 && operation.to_slot.startsWith('IL')) reasons.push('No IL slot is open.');
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
  constructor(config, store, { now = () => Date.now(), fetcher = fetch } = {}) { this.config = config; this.store = store; this.now = now; this.fetcher = fetcher; this.root = join(config.dataDir, 'actions'); this.queue = Promise.resolve(); }
  async init() { await mkdir(join(this.root, 'consumed'), { recursive: true, mode: 0o700 }); }
  serial(operation) { const pending = this.queue.then(operation, operation); this.queue = pending.catch(() => {}); return pending; }
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
    const base = { schema_version: 1, kind: 'action_intent', action_class: input.action_class, league_id: input.league_id, scoring_date: input.scoring_date, expires_at: input.expires_at, operation: input.operation, preconditions: input.preconditions, source_snapshot_ids: [...new Set(input.source_snapshot_ids)].sort(), execution_mode: mode, created_at: new Date(this.now()).toISOString() };
    const intentDigest = canonicalDigest(base), id = `action-${intentDigest.slice(0, 32)}`;
    return this.store.publish({ ...base, id, intent_digest: intentDigest, content_hash: intentDigest }, 'action-intents');
  }
  async authorize(id, input) {
    return this.serial(async () => {
      const intent = await this.store.read(id, 'action-intents');
      if (intent.execution_mode === 'live' && (!this.config.actionGatesVerified || !this.config.actionEnabledClasses.includes(intent.action_class))) throw new Error('Live action class has not passed its promotion gates');
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
      const { intent, authorization, control } = await this.package(id);
      const preflight = preflightAction(intent, input.state, control, this.now());
      if (!preflight.allowed) return this.receipt(intent, authorization, 'blocked', preflight, input.before_evidence_ids || []);
      if (intent.execution_mode === 'shadow') return this.receipt(intent, authorization, 'shadowed', preflight, input.before_evidence_ids || []);
      return this.receipt(intent, authorization, 'preflight_passed', preflight, input.before_evidence_ids || []);
    });
  }
  async arm(id, input) {
    return this.serial(async () => {
      if (!exact(input, ['attempt_id'])) throw new Error('Invalid action arm request');
      const { intent, authorization, control } = await this.package(id);
      const attempt = await this.store.read(input.attempt_id, 'action-attempts');
      if (attempt.intent_id !== id || attempt.status !== 'preflight_passed' || intent.execution_mode !== 'live') throw new Error('Action has not passed a live preflight');
      if (control.stop_switch || control.human_takeover) return { status: 'blocked', intent_id: id, reason: control.stop_switch ? 'The action stop switch is active.' : 'Human takeover is active.' };
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
      return this.receipt(intent, authorization, 'prepared', attempt.preflight, attempt.before_evidence_ids);
    });
  }
  async receipt(intent, authorization, status, preflight, evidenceIds) {
    const id = `action-attempt-${randomUUID()}`;
    const value = { schema_version: 1, kind: 'action_attempt', id, intent_id: intent.id, authorization_digest: authorization.digest, execution_mode: intent.execution_mode, status, preflight, before_evidence_ids: evidenceIds, after_evidence_ids: [], created_at: new Date(this.now()).toISOString(), requires_reconciliation: status === 'prepared' };
    value.content_hash = canonicalDigest(value);
    return this.store.publish(value, 'action-attempts');
  }
  async readback(id, input) {
    return this.serial(async () => {
      if (!exact(input, ['attempt_id', 'outcome', 'before_evidence_ids', 'after_evidence_ids', 'visible_state']) || !['applied', 'blocked', 'ambiguous', 'partial', 'shadowed'].includes(input.outcome) || !Array.isArray(input.before_evidence_ids) || !Array.isArray(input.after_evidence_ids)) throw new Error('Invalid action readback');
      const [intent, attempt] = await Promise.all([this.store.read(id, 'action-intents'), this.store.read(input.attempt_id, 'action-attempts')]);
      if (attempt.intent_id !== id) throw new Error('Invalid action attempt binding');
      if (attempt.status === 'shadowed' && input.outcome !== 'shadowed') throw new Error('Shadow actions cannot report a live mutation');
      const value = { schema_version: 1, kind: 'action_outcome', id: `outcome-${input.attempt_id}`, intent_id: id, attempt_id: input.attempt_id, action_class: intent.action_class, execution_mode: intent.execution_mode, outcome: input.outcome, before_evidence_ids: input.before_evidence_ids, after_evidence_ids: input.after_evidence_ids, visible_state: input.visible_state, recorded_at: new Date(this.now()).toISOString(), requires_reconciliation: ['ambiguous', 'partial'].includes(input.outcome) };
      value.content_hash = canonicalDigest(value);
      return this.store.publish(value, 'action-outcomes');
    });
  }
  async dispatch(id) {
    const { intent, control } = await this.package(id);
    if (control.stop_switch || control.human_takeover) throw new Error('Action dispatch is stopped');
    if (!this.config.actionGatesVerified || !this.config.boxesRunUrl || !this.config.boxesSecret || !this.config.boxesExecutorThreadId) throw new Error('Action executor gates or isolated thread are unavailable');
    const response = await this.fetcher(this.config.boxesRunUrl, { method: 'POST', headers: { Authorization: `Bearer ${this.config.boxesSecret}`, 'Content-Type': 'application/json', 'Idempotency-Key': intent.intent_digest }, body: JSON.stringify({ prompt: `Process ShotCaller intent ${intent.id} using prompts/executor-bounded.md.`, target: { kind: 'existing_thread', threadId: this.config.boxesExecutorThreadId } }), signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (response.status !== 202) throw new Error('Action executor trigger refused');
    const result = await response.json();
    if (!['starting', 'thread_ready'].includes(result.status)) throw new Error('Action executor trigger failed');
    return { intent_id: id, status: 'accepted', execution_mode: intent.execution_mode };
  }
  async status() {
    const [intents, authorizations, attempts, outcomes, control] = await Promise.all(['action-intents', 'action-authorizations', 'action-attempts', 'action-outcomes'].map(folder => this.store.list(folder)).concat(this.control()));
    return { mode: this.config.actionMode, gates_verified: this.config.actionGatesVerified, enabled_classes: this.config.actionEnabledClasses, control, intents, authorizations: authorizations.map(row => ({ id: row.id, intent_id: row.intent_id, stored_at: row.stored_at })), attempts, outcomes };
  }
}
