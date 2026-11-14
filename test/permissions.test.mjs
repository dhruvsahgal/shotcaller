import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signAuthorization, verifyAuthorization } from '../app/permissions.mjs';

const key = 'test-signing-key-with-at-least-32-characters';
const intent = { id: 'action-123', intent_digest: 'a'.repeat(64), action_class: 'lineup_move', league_id: '123', scoring_date: '2026-11-14', expires_at: '2026-11-15T00:00:00Z', operation: { player_id: 'p1', from_slot: 'BN', to_slot: 'PG' }, preconditions: { roster_version: 'v1' }, source_snapshot_ids: ['source-1'] };

test('authorization signs the exact action scope and rejects tampering or expiry', () => {
  const authorization = signAuthorization(intent, { expires_at: '2026-11-14T23:00:00Z', authorized_at: '2026-11-14T10:00:00Z', nonce: '12345678-1234-1234-1234-123456789012' }, key);
  assert.equal(verifyAuthorization(authorization, intent, key, Date.parse('2026-11-14T11:00:00Z')).intent_id, intent.id);
  assert.throws(() => verifyAuthorization({ ...authorization, scoring_date: '2026-11-15' }, intent, key, Date.parse('2026-11-14T11:00:00Z')), /signature/);
  assert.throws(() => verifyAuthorization(authorization, { ...intent, operation: { ...intent.operation, player_id: 'p2' } }, key, Date.parse('2026-11-14T11:00:00Z')), /does not match/);
  assert.throws(() => verifyAuthorization(authorization, intent, key, Date.parse('2026-11-15T00:00:00Z')), /expired/);
});

test('authorization cannot outlive an intent or use an unavailable signing key', () => {
  assert.throws(() => signAuthorization(intent, { expires_at: '2026-11-16T00:00:00Z', authorized_at: '2026-11-14T10:00:00Z' }, key), /outlive/);
  assert.throws(() => signAuthorization(intent, { expires_at: '2026-11-14T23:00:00Z', authorized_at: '2026-11-14T10:00:00Z' }, 'short'), /unavailable/);
});
