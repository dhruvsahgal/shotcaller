import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionService, preflightAction } from '../app/actions.mjs';
import { Store } from '../app/store.mjs';

const now = Date.parse('2026-11-14T10:00:00Z');
const liveState = JSON.parse(await readFile(new URL('./fixtures/actions/live-state.json', import.meta.url), 'utf8'));
const config = mode => ({ dataDir: '', leagueId: '123', actionMode: mode, actionGatesVerified: true, actionEnabledClasses: ['lineup_move', 'add_drop', 'trade_response'], actionSigningKey: 'test-signing-key-with-at-least-32-characters' });
const proposal = (action_class = 'lineup_move', operation = { player_id: 'p1', from_slot: 'BN', to_slot: 'PG' }) => ({ version: 1, action_class, league_id: '123', scoring_date: '2026-11-14', expires_at: '2026-11-14T23:00:00Z', operation, preconditions: { roster_version: 'v1' }, source_snapshot_ids: ['source-1'] });
async function service(mode = 'live') {
  const root = await mkdtemp(join(tmpdir(), 'shotcaller-actions-')), settings = config(mode); settings.dataDir = root;
  return new ActionService(settings, new Store(root), { now: () => now });
}

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
  const first = await actions.arm(intent.id, { attempt_id: preflight.id });
  assert.equal(first.status, 'prepared');
  const retry = await actions.arm(intent.id, { attempt_id: preflight.id });
  assert.equal(retry.status, 'reconcile_required');
});

test('partial completion preserves known state and blocks dependent retries for reconciliation', async () => {
  const actions = await service();
  const intent = await actions.propose(proposal('add_drop', { add_player_id: 'add1', drop_player_id: 'drop1' }));
  await actions.setControl({ stop_switch: false, human_takeover: false });
  await actions.authorize(intent.id, { expires_at: '2026-11-14T22:00:00Z', approved_by: 'manager', nonce: '22345678-1234-1234-1234-123456789012' });
  const preflight = await actions.prepare(intent.id, { state: liveState, before_evidence_ids: ['before'] });
  const attempt = await actions.arm(intent.id, { attempt_id: preflight.id });
  const outcome = await actions.readback(intent.id, { attempt_id: attempt.id, outcome: 'partial', before_evidence_ids: ['before'], after_evidence_ids: ['after'], visible_state: { dropped: true, added: false } });
  assert.equal(outcome.requires_reconciliation, true);
  assert.deepEqual(outcome.visible_state, { dropped: true, added: false });
  assert.equal((await actions.arm(intent.id, { attempt_id: preflight.id })).status, 'reconcile_required');
});

test('a stop or human takeover after preflight blocks arming the mutation', async () => {
  const actions = await service();
  const intent = await actions.propose(proposal());
  await actions.setControl({ stop_switch: false, human_takeover: false });
  await actions.authorize(intent.id, { expires_at: '2026-11-14T22:00:00Z', approved_by: 'manager', nonce: '52345678-1234-1234-1234-123456789012' });
  const preflight = await actions.prepare(intent.id, { state: liveState, before_evidence_ids: ['before'] });
  await actions.setControl({ stop_switch: true, human_takeover: false });
  assert.equal((await actions.arm(intent.id, { attempt_id: preflight.id })).status, 'blocked');
});

test('shadow mode records a complete preflight without consuming permission or claiming mutation', async () => {
  const actions = await service('shadow');
  const intent = await actions.propose(proposal());
  await actions.setControl({ stop_switch: false, human_takeover: false });
  await actions.authorize(intent.id, { expires_at: '2026-11-14T22:00:00Z', approved_by: 'manager', nonce: '32345678-1234-1234-1234-123456789012' });
  const attempt = await actions.prepare(intent.id, { state: liveState, before_evidence_ids: ['before'] });
  assert.equal(attempt.status, 'shadowed');
  assert.equal((await actions.readback(intent.id, { attempt_id: attempt.id, outcome: 'shadowed', before_evidence_ids: ['before'], after_evidence_ids: ['after'], visible_state: { unchanged: true } })).outcome, 'shadowed');
  await assert.rejects(actions.readback(intent.id, { attempt_id: attempt.id, outcome: 'applied', before_evidence_ids: [], after_evidence_ids: [], visible_state: {} }), /Shadow actions/);
});
