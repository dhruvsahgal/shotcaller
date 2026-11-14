import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonical } from './value.mjs';
import { strictInstant } from './time.mjs';

export const actionClasses = Object.freeze(['lineup_move', 'il_move', 'add_drop', 'trade_response']);
const hmac = (key, value) => createHmac('sha256', key).update(JSON.stringify(canonical(value))).digest('hex');
const safeEqual = (a, b) => {
  const left = Buffer.from(a || ''), right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
};

export function authorizationPayload(intent, { expires_at, approved_by = 'manager', nonce = randomUUID(), authorized_at = new Date().toISOString() }) {
  if (!strictInstant(expires_at) || !strictInstant(authorized_at) || Date.parse(expires_at) <= Date.parse(authorized_at)) throw new Error('Invalid action authorization expiry');
  if (Date.parse(expires_at) > Date.parse(intent.expires_at)) throw new Error('Authorization cannot outlive the proposed intent');
  if (approved_by !== 'manager' || typeof nonce !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(nonce)) throw new Error('Invalid action authorization principal or nonce');
  return {
    version: 1, intent_id: intent.id, intent_digest: intent.intent_digest, action_class: intent.action_class,
    league_id: intent.league_id, operation: intent.operation, scoring_date: intent.scoring_date,
    preconditions: intent.preconditions, source_snapshot_ids: intent.source_snapshot_ids,
    approved_by, authorized_at, expires_at, nonce
  };
}

export function signAuthorization(intent, input, signingKey) {
  if (typeof signingKey !== 'string' || signingKey.length < 32) throw new Error('Action signing key is unavailable');
  const payload = authorizationPayload(intent, input);
  return { ...payload, digest: hmac(signingKey, payload), signature_algorithm: 'hmac-sha256' };
}

export function verifyAuthorization(authorization, intent, signingKey, now = Date.now()) {
  if (!authorization || authorization.signature_algorithm !== 'hmac-sha256') throw new Error('Invalid action authorization');
  const { digest, signature_algorithm: _algorithm, ...payload } = authorization;
  if (!safeEqual(digest, hmac(signingKey, payload))) throw new Error('Invalid action authorization signature');
  if (payload.intent_id !== intent.id || payload.intent_digest !== intent.intent_digest || payload.league_id !== intent.league_id || payload.action_class !== intent.action_class || JSON.stringify(canonical(payload.operation)) !== JSON.stringify(canonical(intent.operation)) || JSON.stringify(canonical(payload.preconditions)) !== JSON.stringify(canonical(intent.preconditions))) throw new Error('Action authorization does not match the intent');
  if (!strictInstant(payload.expires_at) || Date.parse(payload.expires_at) <= now) throw new Error('Action authorization expired');
  return payload;
}
