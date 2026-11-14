#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { strictInstant } from '../app/time.mjs';

const yahooFantasyHost = 'basketball.fantasysports.yahoo.com';
const yahooHosts = new Set([yahooFantasyHost, 'sports.yahoo.com']);
const outputKeys = ['contract_version', 'collector_mode', 'decision_output', 'status', 'league', 'team', 'scoring_period', 'scope', 'allowed_pages', 'source', 'coverage', 'roster', 'login', 'warnings'];
const sessionQueryNames = /^(?:sid|session|sessionid|session_id|crumb|token|access_token|auth|authorization|key|code|state|nonce|password|passwd|email|account|user|username|login)$/i;
const safeSourceQueryNames = new Set(['date', 'week', 'stat1', 'stat2']);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const evidenceReference = /^evidence\/[A-Za-z0-9._/-]+(?:#[A-Za-z0-9._:-]+)?$/;
const allowedSlotGroups = new Set(['active', 'bench', 'il']);
const loginChallenges = new Set(['login', 'passkey', 'consent', 'challenge']);

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function exactKeys(value, keys, label) {
  assert(plainObject(value), `Invalid ${label}`);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) assert(expected.has(key), `Unexpected ${label} key: ${key}`);
  for (const key of keys) assert(Object.hasOwn(value, key), `Missing ${label} key: ${key}`);
}

function nullableText(value, label, { required = false, max = 160 } = {}) {
  if (value === null) {
    assert(!required, `${label} cannot be null`);
    return;
  }
  assert(typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value), `Invalid ${label}`);
}

function integerOrNull(value, label) {
  assert(value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 30), `Invalid ${label}`);
}

function validateEvidenceReferences(refs, label) {
  assert(Array.isArray(refs) && refs.length > 0 && refs.length <= 30, `Invalid ${label}`);
  assert(new Set(refs).size === refs.length, `Duplicate ${label}`);
  for (const ref of refs) {
    assert(typeof ref === 'string' && ref.length <= 240 && evidenceReference.test(ref) && !ref.includes('..'), `Invalid ${label}`);
  }
}

function parsedUrl(value, label) {
  assert(typeof value === 'string' && value.length <= 2048, `Invalid ${label}`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${label}`); }
  assert(url.protocol === 'https:' && !url.username && !url.password, `Invalid ${label}`);
  return url;
}

function canonicalReadPage(url) {
  url.searchParams.sort();
  return `${url.origin}${url.pathname.replace(/\/$/, '')}${url.search}`;
}

export function redactCollectorUrl(value) {
  const url = parsedUrl(value, 'collector URL');
  for (const key of [...url.searchParams.keys()]) {
    if (sessionQueryNames.test(key)) url.searchParams.set(key, '[REDACTED]');
  }
  url.hash = '';
  return url.toString();
}

function validateRosterPage(value, leagueId, teamId, label = 'allowed page') {
  const url = parsedUrl(value, label);
  assert(url.hostname === yahooFantasyHost, `${label} must be a Yahoo Fantasy page`);
  assert(!url.hash, `${label} must not contain fragment data`);
  for (const key of url.searchParams.keys()) assert(safeSourceQueryNames.has(key), `${label} query is outside the roster scope: ${key}`);
  const expected = `/nba/${encodeURIComponent(leagueId)}/${encodeURIComponent(teamId)}`;
  assert(url.pathname.replace(/\/$/, '') === expected, `${label} is outside the bounded team roster scope`);
  return canonicalReadPage(url);
}

function validateSourcePage(value, allowedPages) {
  const original = parsedUrl(value, 'source URL');
  for (const [key, queryValue] of original.searchParams) {
    if (sessionQueryNames.test(key)) assert(queryValue === '[REDACTED]', `Source URL must redact ${key}`);
  }
  const redacted = redactCollectorUrl(value);
  const url = new URL(redacted);
  assert(url.hostname === yahooFantasyHost, 'Source URL must be a Yahoo Fantasy page');
  for (const key of url.searchParams.keys()) {
    assert(safeSourceQueryNames.has(key) || sessionQueryNames.test(key), `Source URL query is outside the roster scope: ${key}`);
  }
  const sourceForScope = new URL(url);
  for (const key of [...sourceForScope.searchParams.keys()]) {
    if (sessionQueryNames.test(key)) sourceForScope.searchParams.delete(key);
  }
  const sourcePage = canonicalReadPage(sourceForScope);
  assert(allowedPages.includes(sourcePage), 'Source URL does not match an allowed page');
  return redacted;
}

function validateIdentity(value, label, allowNull) {
  if (value === null && allowNull) return;
  assert(typeof value === 'string' && identifier.test(value), `Invalid ${label}`);
}

function validateRosterRow(row, index, status, missingFields) {
  const label = `roster[${index}]`;
  exactKeys(row, ['player_id', 'player_url', 'name', 'nba_team', 'eligibility', 'slot', 'injury', 'evidence_refs'], label);
  const mayBeUnknown = status === 'partial';
  validateIdentity(row.player_id, `${label}.player_id`, true);
  if (row.player_url !== null) {
    const url = parsedUrl(row.player_url, `${label}.player_url`);
    assert(yahooHosts.has(url.hostname) && /^\/nba\/players\/[A-Za-z0-9._-]+\/?$/.test(url.pathname), `Invalid ${label}.player_url`);
    assert(!url.search && !url.hash, `Invalid ${label}.player_url`);
  }
  assert(row.player_id !== null || row.player_url !== null || (mayBeUnknown && missingFields.includes(`${label}.identity`)), `${label} requires a stable Yahoo ID or player link`);
  nullableText(row.name, `${label}.name`, { required: !mayBeUnknown });
  nullableText(row.nba_team, `${label}.nba_team`, { required: !mayBeUnknown, max: 32 });
  for (const field of ['name', 'nba_team']) {
    if (row[field] === null) assert(mayBeUnknown && missingFields.includes(`${label}.${field}`), `${label}.${field} null must be listed in coverage.missing_fields`);
  }
  if (row.eligibility !== null) {
    assert(Array.isArray(row.eligibility) && row.eligibility.length > 0 && row.eligibility.length <= 10 && new Set(row.eligibility).size === row.eligibility.length, `Invalid ${label}.eligibility`);
    row.eligibility.forEach(position => nullableText(position, `${label}.eligibility`, { required: true, max: 12 }));
  } else assert(mayBeUnknown && missingFields.includes(`${label}.eligibility`), `Invalid ${label}.eligibility`);
  if (row.slot !== null) {
    exactKeys(row.slot, ['group', 'label'], `${label}.slot`);
    assert(allowedSlotGroups.has(row.slot.group), `Invalid ${label}.slot.group`);
    nullableText(row.slot.label, `${label}.slot.label`, { required: true, max: 16 });
  } else assert(mayBeUnknown && missingFields.includes(`${label}.slot`), `Invalid ${label}.slot`);
  nullableText(row.injury, `${label}.injury`, { max: 64 });
  validateEvidenceReferences(row.evidence_refs, `${label}.evidence_refs`);
}

export function validateCollectorOutput(input) {
  exactKeys(input, outputKeys, 'collector output');
  assert(input.contract_version === 1, 'Unsupported collector contract version');
  assert(input.collector_mode === 'observation_only', 'Collector mode must be observation_only');
  assert(input.decision_output === false, 'Collector cannot produce decisions');
  assert(['complete', 'partial', 'needs_login'].includes(input.status), 'Invalid collector status');

  exactKeys(input.league, ['id', 'name'], 'league');
  exactKeys(input.team, ['id', 'name'], 'team');
  validateIdentity(input.league.id, 'league.id', false);
  validateIdentity(input.team.id, 'team.id', false);
  nullableText(input.league.name, 'league.name', { required: input.status !== 'needs_login' });
  nullableText(input.team.name, 'team.name', { required: input.status !== 'needs_login' });

  exactKeys(input.scoring_period, ['kind', 'key', 'timezone'], 'scoring_period');
  for (const key of ['kind', 'key', 'timezone']) nullableText(input.scoring_period[key], `scoring_period.${key}`, { required: input.status !== 'needs_login', max: 64 });
  if (input.status !== 'needs_login') assert(['week', 'date'].includes(input.scoring_period.kind), 'Invalid scoring_period.kind');

  exactKeys(input.scope, ['dataset', 'league_id', 'team_id'], 'scope');
  assert(input.scope.dataset === 'team_roster', 'Collector scope is limited to team_roster');
  assert(input.scope.league_id === input.league.id && input.scope.team_id === input.team.id, 'Collector scope identity mismatch');

  assert(Array.isArray(input.allowed_pages) && input.allowed_pages.length > 0 && input.allowed_pages.length <= 4, 'Invalid allowed pages');
  const allowedPages = input.allowed_pages.map(page => validateRosterPage(page, input.league.id, input.team.id));
  assert(new Set(allowedPages).size === allowedPages.length, 'Duplicate allowed page');

  exactKeys(input.source, ['url', 'observed_at', 'evidence_refs'], 'source');
  const sourceUrl = validateSourcePage(input.source.url, allowedPages);
  assert(strictInstant(input.source.observed_at), 'Invalid source observed time');
  validateEvidenceReferences(input.source.evidence_refs, 'source.evidence_refs');

  exactKeys(input.coverage, ['visible_rows', 'extracted_rows', 'missing_rows', 'missing_fields', 'row_reconciled', 'note'], 'coverage');
  integerOrNull(input.coverage.visible_rows, 'coverage.visible_rows');
  integerOrNull(input.coverage.extracted_rows, 'coverage.extracted_rows');
  integerOrNull(input.coverage.missing_rows, 'coverage.missing_rows');
  assert(typeof input.coverage.row_reconciled === 'boolean', 'Invalid coverage.row_reconciled');
  nullableText(input.coverage.note, 'coverage.note', { max: 500 });
  assert(Array.isArray(input.coverage.missing_fields) && input.coverage.missing_fields.length <= 60 && new Set(input.coverage.missing_fields).size === input.coverage.missing_fields.length, 'Invalid coverage.missing_fields');
  input.coverage.missing_fields.forEach(field => assert(typeof field === 'string' && /^[A-Za-z][A-Za-z0-9_.\[\]-]{0,127}$/.test(field), 'Invalid coverage.missing_fields'));
  if (input.status === 'partial') {
    for (const [path, value] of [
      ['league.name', input.league.name],
      ['team.name', input.team.name],
      ['scoring_period.kind', input.scoring_period.kind],
      ['scoring_period.key', input.scoring_period.key],
      ['scoring_period.timezone', input.scoring_period.timezone]
    ]) {
      if (value === null) assert(input.coverage.missing_fields.includes(path), `${path} null must be listed in coverage.missing_fields`);
    }
  }

  assert(Array.isArray(input.roster) && input.roster.length <= 30, 'Invalid roster');
  assert(input.coverage.extracted_rows === input.roster.length, 'Extracted row count does not match roster');
  input.roster.forEach((row, index) => validateRosterRow(row, index, input.status, input.coverage.missing_fields));

  exactKeys(input.login, ['required', 'challenge'], 'login');
  assert(typeof input.login.required === 'boolean', 'Invalid login.required');
  assert(input.login.challenge === null || loginChallenges.has(input.login.challenge), 'Invalid login.challenge');
  assert(Array.isArray(input.warnings) && input.warnings.length <= 20, 'Invalid warnings');
  input.warnings.forEach(warning => nullableText(warning, 'warning', { required: true, max: 500 }));

  if (input.status === 'complete') {
    assert(input.login.required === false && input.login.challenge === null, 'Complete output cannot require login');
    assert(input.coverage.visible_rows === input.roster.length && input.coverage.missing_rows === 0 && input.coverage.missing_fields.length === 0 && input.coverage.row_reconciled, 'Complete output must reconcile every visible row and field');
    assert(input.warnings.length === 0, 'Complete output cannot contain coverage warnings');
  } else if (input.status === 'partial') {
    assert(input.login.required === false && input.login.challenge === null, 'Use needs_login for authentication interruptions');
    assert(input.coverage.visible_rows !== null && input.coverage.missing_rows !== null, 'Partial roster must report visible and missing row counts when the table was visible');
    assert(input.coverage.visible_rows === input.coverage.extracted_rows + input.coverage.missing_rows, 'Partial visible-row reconciliation failed');
    assert(input.coverage.row_reconciled, 'Partial roster counts must be reconciled');
    assert(input.coverage.missing_rows > 0 || input.coverage.missing_fields.length > 0 || input.warnings.length > 0, 'Partial output must state what is incomplete');
    assert(input.coverage.note !== null, 'Partial output requires a coverage note');
  } else {
    assert(input.login.required === true && input.login.challenge !== null, 'needs_login requires an explicit login challenge');
    assert(input.roster.length === 0 && input.coverage.extracted_rows === 0, 'needs_login cannot contain roster observations');
    assert(input.coverage.visible_rows === null && input.coverage.missing_rows === null && input.coverage.row_reconciled === false, 'needs_login cannot claim visible-row reconciliation');
    assert(input.scoring_period.kind === null && input.scoring_period.key === null && input.scoring_period.timezone === null, 'needs_login cannot claim a scoring period');
    assert(input.coverage.note !== null && input.warnings.length > 0, 'needs_login requires an operator-facing reason');
  }

  const output = structuredClone(input);
  output.allowed_pages = allowedPages;
  output.source.url = sourceUrl;
  return output;
}

const blockedActionPatterns = Object.freeze({
  lineup: /(?:edit[-_]?lineup|lineup|roster[-_]?change|edit[-_]?roster|move[-_]?to[-_]?(?:bench|il))/i,
  add_drop: /(?:add[-_]?player|drop[-_]?player|add[-_]?drop|waiver|players?\/add|players?\/drop)/i,
  trade: /(?:trade|proposal|offer)/i,
  messaging: /(?:message|compose|inbox|chat)/i
});

export const mutationGuardPolicy = Object.freeze({
  version: 1,
  mode: 'default_deny',
  allowed_methods: Object.freeze(['GET', 'HEAD']),
  allowed_page_kind: 'team_roster',
  requires_exact_allowed_page: true,
  blocked_action_classes: Object.freeze(['lineup', 'add_drop', 'trade', 'messaging'])
});

function classifyAction(url, method) {
  const target = `${url.pathname}${url.search}`;
  for (const actionClass of mutationGuardPolicy.blocked_action_classes) {
    if (blockedActionPatterns[actionClass].test(target)) return actionClass;
  }
  if (!mutationGuardPolicy.allowed_methods.includes(method)) return 'lineup';
  return null;
}

export function validateCollectorRequest({ method, url, allowedPages }) {
  const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : '';
  let parsed;
  try { parsed = parsedUrl(url, 'request URL'); } catch { return { allowed: false, action_class: 'invalid_request', reason: 'invalid_url' }; }
  const actionClass = classifyAction(parsed, normalizedMethod);
  if (actionClass) return { allowed: false, action_class: actionClass, reason: 'blocked_action_class' };
  if (parsed.hostname !== yahooFantasyHost) return { allowed: false, action_class: 'external_navigation', reason: 'host_not_allowed' };
  if (!Array.isArray(allowedPages) || allowedPages.length === 0 || allowedPages.length > 4) return { allowed: false, action_class: 'out_of_scope', reason: 'missing_allowed_pages' };
  let allowed;
  try {
    allowed = allowedPages.map(page => {
      const candidate = parsedUrl(page, 'allowed page');
      assert(candidate.hostname === yahooFantasyHost && !candidate.hash, 'Invalid allowed page');
      for (const key of candidate.searchParams.keys()) assert(safeSourceQueryNames.has(key), 'Invalid allowed page');
      return canonicalReadPage(candidate);
    });
  } catch {
    return { allowed: false, action_class: 'out_of_scope', reason: 'invalid_allowed_pages' };
  }
  for (const key of parsed.searchParams.keys()) {
    if (!safeSourceQueryNames.has(key)) return { allowed: false, action_class: 'out_of_scope', reason: 'query_not_allowed' };
  }
  const candidate = canonicalReadPage(parsed);
  if (!allowed.includes(candidate)) return { allowed: false, action_class: 'out_of_scope', reason: 'page_not_allowed' };
  return { allowed: true, action_class: null, reason: 'bounded_read' };
}

async function cli(argv) {
  if (argv[0] === '--policy') {
    process.stdout.write(`${JSON.stringify(mutationGuardPolicy)}\n`);
    return;
  }
  if (argv[0] === '--guard') {
    const [method, url, ...allowedPages] = argv.slice(1);
    const result = validateCollectorRequest({ method, url, allowedPages });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.allowed) process.exitCode = 3;
    return;
  }
  assert(argv.length === 1, 'Usage: validate-collector-output.mjs <json-file>');
  const bytes = await readFile(argv[0]);
  assert(bytes.length <= 256 * 1024, 'Collector output exceeds 256 KiB');
  let input;
  try { input = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Collector output is not valid JSON'); }
  const output = validateCollectorOutput(input);
  process.stdout.write(`${JSON.stringify({ valid: true, status: output.status, rows: output.roster.length, visible_rows: output.coverage.visible_rows })}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) cli(process.argv.slice(2)).catch(error => {
  process.stderr.write(`Collector output rejected: ${error.message}\n`);
  process.exitCode = 1;
});
