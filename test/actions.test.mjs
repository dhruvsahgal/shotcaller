import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionService, actionAttemptTransitions, actionOutcomeTransitions, preflightAction, validateActionProposal } from '../app/actions.mjs';
import { Store } from '../app/store.mjs';

const now = Date.parse('2026-11-14T10:00:00Z');
const liveState = JSON.parse(await readFile(new URL('./fixtures/actions/live-state.json', import.meta.url), 'utf8'));
const config = mode => ({ dataDir: '', leagueId: '123', actionMode: mode, actionGatesVerified: true, actionEnabledClasses: ['lineup_move', 'il_move', 'add_drop', 'trade_response'], actionSigningKey: 'test-signing-key-with-at-least-32-characters', actionMaxObservationAgeMs: 120_000 });
const proposal = (action_class = 'lineup_move', operation = { player_id: 'p1', from_slot: 'BN', to_slot: 'PG' }) => ({ version: 1, action_class, league_id: '123', scoring_date: '2026-11-14', expires_at: '2026-11-14T23:00:00Z', operation, preconditions: { roster_version: 'v1' }, source_snapshot_ids: ['source-1'] });
const armInput = attempt_id => ({ attempt_id, state: liveState, before_evidence_ids: ['before-arm'], observed_at: '2026-11-14T09:59:30Z' });
async function service(mode = 'live', options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-actions-')), settings = config(mode); settings.dataDir = root;
  return new ActionService(settings, new Store(root), { now: () => now, ...options });
}

test('attempt and outcome transitions are explicit and terminal states have no exits', () => {
  assert.deepEqual(actionAttemptTransitions.preflight_passed, ['blocked', 'prepared']);
  assert.deepEqual(actionAttemptTransitions.blocked, []);
  assert.deepEqual(actionOutcomeTransitions.prepared, ['applied', 'blocked', 'ambiguous', 'partial']);
  assert.deepEqual(actionOutcomeTransitions.applied, []);
  assert.deepEqual(actionOutcomeTransitions.blocked, []);
});

test('expired, locked, wrong-date and wrong-offer actions fail deterministic preflight', () => {
  const intent = { ...proposal(), id: 'action-1', intent_digest: 'a'.repeat(64) };
  assert.match(preflightAction(intent, { ...liveState, scoring_date: '2026-11-15' }, {}, now).reasons.join(' '), /scoring date/);
  assert.match(preflightAction(intent, { ...liveState, started_player_ids: ['p1'] }, {}, now).reasons.join(' '), /started or locked/);
  assert.match(preflightAction({ ...intent, expires_at: '2026-11-14T09:00:00Z' }, liveState, {}, now).reasons.join(' '), /expired/);
  const trade = { ...proposal('trade_response', { offer_id: 'offer1', response: 'reject' }), id: 'action-2', intent_digest: 'b'.repeat(64) };
  assert.match(preflightAction(trade, { ...liveState, visible_offer_id: 'offer2' }, {}, now).reasons.join(' '), /does not match/);
});

test('stop switch and human takeover block the next mutation', () => {
  const intent = { ...proposal(), id: 'action-1', intent_digest: 'a'.repeat(64) };
  assert.equal(preflightAction(intent, liveState, { stop_switch: true }, now).allowed, false);
  assert.equal(preflightAction(intent, liveState, { human_takeover: true }, now).allowed, false);
});

test('live nonce is single-use and a lost response requires reconciliation rather than a second click', async () => {
  const actions = await service();
  const intent = await actions.propose(proposal());
  await actions.setControl({ stop_switch: false, human_takeover: false });
  await actions.authorize(intent.id, { expires_at: '2026-11-14T22:00:00Z', approved_by: 'manager', nonce: '12345678-1234-1234-1234-123456789012' });
  const preflight = await actions.prepare(intent.id, { state: liveState, before_evidence_ids: ['before-1'] });
  assert.equal(preflight.status, 'preflight_passed');
  const first = await actions.arm(intent.id, armInput(preflight.id));
  assert.equal(first.status, 'prepared');
  const retry = await actions.arm(intent.id, armInput(preflight.id));
  assert.equal(retry.status, 'reconcile_required');
});

test('partial completion preserves known state and blocks dependent retries for reconciliation', async () => {
  const actions = await service();
  const intent = await actions.propose(proposal('add_drop', { add_player_id: 'add1', drop_player_id: 'drop1' }));
  await actions.setControl({ stop_switch: false, human_takeover: false });
  await actions.authorize(intent.id, { expires_at: '2026-11-14T22:00:00Z', approved_by: 'manager', nonce: '22345678-1234-1234-1234-123456789012' });
  const preflight = await actions.prepare(intent.id, { state: liveState, before_evidence_ids: ['before'] });
  const attempt = await actions.arm(intent.id, armInput(preflight.id));
  const outcome = await actions.readback(intent.id, { attempt_id: attempt.id, outcome: 'partial', before_evidence_ids: ['before'], after_evidence_ids: ['after'], visible_state: { dropped: true, added: false } });
  assert.equal(outcome.requires_reconciliation, true);
  assert.deepEqual(outcome.visible_state, { dropped: true, added: false });
  const retry = await actions.readback(intent.id, { attempt_id: attempt.id, outcome: 'partial', before_evidence_ids: ['before'], after_evidence_ids: ['after'], visible_state: { dropped: true, added: false } });
  assert.equal(retry.id, outcome.id);
  const reconciled = await actions.readback(intent.id, { attempt_id: attempt.id, outcome: 'applied', before_evidence_ids: ['before'], after_evidence_ids: ['confirmed'], visible_state: { dropped: true, added: true } });
  assert.equal(reconciled.kind, 'action_reconciliation');
  assert.equal(reconciled.previous_record_id, outcome.id);
  assert.equal(reconciled.requires_reconciliation, false);
  assert.equal((await actions.arm(intent.id, armInput(preflight.id))).status, 'reconcile_required');
  await assert.rejects(actions.readback(intent.id, { attempt_id: attempt.id, outcome: 'blocked', before_evidence_ids: ['before'], after_evidence_ids: ['changed'], visible_state: {} }), /Forbidden action transition/);
});

test('identical readback retry stays idempotent after time advances', async () => {
  let clock = now;
  const actions = await service('live', { now: () => clock });
  const intent = await actions.propose(proposal());
  await actions.setControl({ stop_switch: false, human_takeover: false });
  await actions.authorize(intent.id, { expires_at: '2026-11-14T22:00:00Z', approved_by: 'manager', nonce: '42345678-1234-1234-1234-123456789012' });
  const preflight = await actions.prepare(intent.id, { state: liveState, before_evidence_ids: ['before'] });
  const attempt = await actions.arm(intent.id, armInput(preflight.id));
  const input = { attempt_id: attempt.id, outcome: 'applied', before_evidence_ids: ['before'], after_evidence_ids: ['after'], visible_state: { slot: 'PG' } };
  const first = await actions.readback(intent.id, input);
  clock += 30_000;
  const retry = await actions.readback(intent.id, input);
  assert.equal(retry.id, first.id);
  assert.equal(retry.recorded_at, first.recorded_at);
});

test('a stop or human takeover after preflight blocks arming the mutation', async () => {
  const actions = await service();
  const intent = await actions.propose(proposal());
  await actions.setControl({ stop_switch: false, human_takeover: false });
  await actions.authorize(intent.id, { expires_at: '2026-11-14T22:00:00Z', approved_by: 'manager', nonce: '52345678-1234-1234-1234-123456789012' });
  const preflight = await actions.prepare(intent.id, { state: liveState, before_evidence_ids: ['before'] });
  await actions.setControl({ stop_switch: true, human_takeover: false });
  const blocked = await actions.arm(intent.id, armInput(preflight.id));
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.preflight.reasons.join(' '), /stop switch/);
  await actions.setControl({ stop_switch: false, human_takeover: false });
  assert.equal((await actions.arm(intent.id, armInput(preflight.id))).id, blocked.id);
});

test('shadow mode records a complete preflight without consuming permission or claiming mutation', async () => {
  const actions = await service('shadow');
  const intent = await actions.propose(proposal());
  await actions.setControl({ stop_switch: false, human_takeover: false });
  await actions.authorize(intent.id, { expires_at: '2026-11-14T22:00:00Z', approved_by: 'manager', nonce: '32345678-1234-1234-1234-123456789012' });
  const attempt = await actions.prepare(intent.id, { state: liveState, before_evidence_ids: ['before'] });
  assert.equal(attempt.status, 'shadowed');
  assert.equal((await actions.readback(intent.id, { attempt_id: attempt.id, outcome: 'shadowed', before_evidence_ids: ['before'], after_evidence_ids: ['after'], visible_state: { unchanged: true } })).outcome, 'shadowed');
  await assert.rejects(actions.readback(intent.id, { attempt_id: attempt.id, outcome: 'applied', before_evidence_ids: ['before'], after_evidence_ids: ['after'], visible_state: {} }), /Forbidden action transition/);
});

test('arming repeats preflight with fresh evidence and rejects stale or changed state', async () => {
  const actions = await service();
  const intent = await actions.propose(proposal());
  await actions.setControl({ stop_switch: false, human_takeover: false });
  await actions.authorize(intent.id, { expires_at: '2026-11-14T22:00:00Z', approved_by: 'manager', nonce: '62345678-1234-1234-1234-123456789012' });
  const preflight = await actions.prepare(intent.id, { state: liveState, before_evidence_ids: ['before'] });
  await assert.rejects(actions.arm(intent.id, { ...armInput(preflight.id), observed_at: '2026-11-14T09:57:59Z' }), /stale/);
  const changed = await actions.arm(intent.id, { ...armInput(preflight.id), state: { ...liveState, slots: { ...liveState.slots, p1: 'Util' } } });
  assert.equal(changed.status, 'blocked');
  assert.match(changed.preflight.reasons.join(' '), /source slot changed/);
});

test('gate revocation or shadow restart blocks arm and dispatch even for a live intent', async () => {
  const actions = await service();
  const intent = await actions.propose(proposal());
  await actions.setControl({ stop_switch: false, human_takeover: false });
  await actions.authorize(intent.id, { expires_at: '2026-11-14T22:00:00Z', approved_by: 'manager', nonce: '72345678-1234-1234-1234-123456789012' });
  const preflight = await actions.prepare(intent.id, { state: liveState, before_evidence_ids: ['before'] });
  actions.config.actionGatesVerified = false;
  await assert.rejects(actions.arm(intent.id, armInput(preflight.id)), /gates/);
  await assert.rejects(actions.dispatch(intent.id), /gates/);
  actions.config.actionGatesVerified = true;
  const restarted = new ActionService({ ...actions.config, actionMode: 'shadow' }, actions.store, { now: () => now });
  await assert.rejects(restarted.arm(intent.id, armInput(preflight.id)), /mode/);
  await assert.rejects(restarted.dispatch(intent.id), /mode/);
});

test('IL entry and activation use direction-specific eligibility and capacity', () => {
  const entry = { ...proposal('il_move', { player_id: 'p1', from_slot: 'BN', to_slot: 'IL' }), id: 'action-il-1' };
  assert.equal(preflightAction(entry, liveState, {}, now).allowed, true);
  const activation = { ...proposal('il_move', { player_id: 'p1', from_slot: 'IL', to_slot: 'BN' }), id: 'action-il-2' };
  const state = { ...liveState, slots: { ...liveState.slots, p1: 'IL' }, eligible_slots: { ...liveState.eligible_slots, p1: [] }, injury_eligible_player_ids: [], open_il_slots: 0, open_active_slots: 1 };
  assert.equal(preflightAction(activation, state, {}, now).allowed, true);
  assert.match(preflightAction(activation, { ...state, open_active_slots: 0 }, {}, now).reasons.join(' '), /active roster slot/);
  assert.throws(() => validateActionProposal(proposal('il_move', { player_id: 'p1', from_slot: 'BN', to_slot: 'Util' }), now), /Invalid IL move/);
});

test('action evidence hooks bind every execution phase and reject duplicate evidence IDs', async () => {
  const phases = [];
  const actions = await service('live', { evidenceValidator: async input => phases.push(input.phase) });
  const intent = await actions.propose(proposal());
  await actions.setControl({ stop_switch: false, human_takeover: false });
  await actions.authorize(intent.id, { expires_at: '2026-11-14T22:00:00Z', approved_by: 'manager', nonce: '82345678-1234-1234-1234-123456789012' });
  await assert.rejects(actions.prepare(intent.id, { state: liveState, before_evidence_ids: ['same', 'same'] }), /Invalid before action evidence/);
  const preflight = await actions.prepare(intent.id, { state: liveState, before_evidence_ids: ['before'] });
  const attempt = await actions.arm(intent.id, armInput(preflight.id));
  await actions.readback(intent.id, { attempt_id: attempt.id, outcome: 'applied', before_evidence_ids: ['before'], after_evidence_ids: ['after'], visible_state: { slot: 'PG' } });
  assert.deepEqual(phases, ['source', 'before', 'arm', 'readback-before', 'readback-after']);
});
