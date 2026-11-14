import { validateEvidenceScope, validateIdentifier, validateRecordLinks, validateTimestamp } from './schema.mjs';

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const terminalOutcomes = new Set(['complete', 'partial', 'failed', 'cancelled', 'needs_login', 'timed_out']);

export function runEnvelope(input, storedAt, contentHash) {
  if (!plainObject(input)) throw new Error('Invalid run');
  validateIdentifier(input.id, 'run id');
  validateIdentifier(input.job_id, 'job id');
  if (typeof input.idempotency_key !== 'string' || !input.idempotency_key.trim() || input.idempotency_key.length > 256) throw new Error('Invalid run idempotency key');
  if (input.automation_id != null && (typeof input.automation_id !== 'string' || !input.automation_id)) throw new Error('Invalid run automation id');
  if (input.thread_id != null && (typeof input.thread_id !== 'string' || !input.thread_id)) throw new Error('Invalid run thread id');
  validateEvidenceScope(input.scope);
  validateTimestamp(input.intended_for, 'run intended time');
  validateTimestamp(input.created_at, 'run creation time');
  if (!plainObject(input.budget) || typeof input.budget.unit !== 'string' || !input.budget.unit || !Number.isFinite(input.budget.limit) || input.budget.limit < 0) throw new Error('Invalid run budget');
  validateRecordLinks(input.links ?? {});
  return { schema_version: 1, kind: 'collection_run', ...structuredClone(input), links: structuredClone(input.links ?? {}), stored_at: storedAt, content_hash: contentHash };
}

export function attemptEnvelope(input, storedAt, contentHash) {
  if (!plainObject(input)) throw new Error('Invalid run attempt');
  validateIdentifier(input.id, 'attempt id');
  validateIdentifier(input.run_id, 'attempt run id');
  validateTimestamp(input.started_at, 'attempt start time');
  validateTimestamp(input.finished_at, 'attempt finish time');
  if (Date.parse(input.finished_at) < Date.parse(input.started_at)) throw new Error('Invalid run attempt timestamps');
  if (!terminalOutcomes.has(input.outcome)) throw new Error('Invalid run attempt outcome');
  if (!Array.isArray(input.artifact_ids) || new Set(input.artifact_ids).size !== input.artifact_ids.length) throw new Error('Invalid run attempt artifacts');
  input.artifact_ids.forEach(id => validateIdentifier(id, 'artifact id'));
  validateRecordLinks(input.links ?? {});
  return { schema_version: 1, kind: 'collection_attempt', ...structuredClone(input), links: structuredClone(input.links ?? {}), stored_at: storedAt, content_hash: contentHash };
}
