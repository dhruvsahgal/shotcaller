import { validateEvidenceScope, validateIdentifier, validateRecordLinks, validateTimestamp } from './schema.mjs';
import { validDate } from './time.mjs';

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value)
  ? value.map(canonical)
  : plainObject(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;

export function observationScopeKey(scope) {
  validateEvidenceScope(scope);
  return JSON.stringify(canonical({
    dataset: scope.dataset,
    league_id: scope.league_id,
    season: scope.season,
    team_id: scope.team_id ?? null,
    matchup_id: scope.matchup_id ?? null,
    scoring_period: scope.scoring_period,
    value_basis: scope.value_basis
  }));
}

export function compareObservations(a, b) {
  const observedTime = value => value == null || !Number.isFinite(Date.parse(value)) ? -Infinity : Date.parse(value);
  const observed = observedTime(a.observed_at) - observedTime(b.observed_at);
  if (observed !== 0) return observed;
  const stored = Date.parse(a.stored_at) - Date.parse(b.stored_at);
  if (stored !== 0) return stored;
  return String(a.id).localeCompare(String(b.id));
}

export function observationEnvelope(input, storedAt, contentHash) {
  if (!plainObject(input)) throw new Error('Invalid observation');
  validateIdentifier(input.id, 'observation id');
  if (!plainObject(input.source) || typeof input.source.id !== 'string' || !input.source.id || !/^[a-f0-9]{64}$/i.test(input.source.hash || '')) throw new Error('Invalid observation source');
  if (!['instant', 'date', 'approximate', 'unknown'].includes(input.observed_at_precision)) throw new Error('Invalid observation time precision');
  if (input.observed_at_precision === 'unknown') {
    if (input.observed_at !== null) throw new Error('Unknown observation time must be null');
  } else if (input.observed_at_precision === 'date') {
    if (!validDate(input.observed_at)) throw new Error('Invalid observation time');
  } else validateTimestamp(input.observed_at, 'observation time');
  validateEvidenceScope(input.scope);
  if (!plainObject(input.coverage) || !['complete', 'partial', 'unknown'].includes(input.coverage.status) || typeof input.coverage.note !== 'string' || !input.coverage.note.trim()) throw new Error('Invalid observation coverage');
  if (typeof input.parser_version !== 'string' || !input.parser_version) throw new Error('Invalid observation parser version');
  if (!plainObject(input.data) && !Array.isArray(input.data)) throw new Error('Invalid observation data');
  if (input.correction_of != null) validateIdentifier(input.correction_of, 'correction id');
  validateRecordLinks(input.links ?? {});
  validateTimestamp(storedAt, 'storage time');
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('Invalid observation content hash');
  return {
    schema_version: 1,
    kind: 'observation',
    ...structuredClone(input),
    team_id: input.scope.team_id ?? null,
    matchup_id: input.scope.matchup_id ?? null,
    correction_of: input.correction_of ?? null,
    links: structuredClone(input.links ?? {}),
    stored_at: storedAt,
    content_hash: contentHash
  };
}
