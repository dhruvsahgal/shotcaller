import { strictInstant } from './time.mjs';

export const countKeys = ['gp', 'fgm', 'fga', 'ftm', 'fta', 'three_pm', 'pts', 'oreb', 'reb', 'ast', 'stl', 'blk'];
export const categoryKeys = ['fg_pct', 'ft_pct', 'three_pm', 'pts', 'oreb', 'reb', 'ast', 'stl', 'blk'];
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const recordLinkKinds = ['evidence', 'forecasts', 'decisions', 'actions', 'outcomes'];

export function validateIdentifier(value, label = 'identifier') {
  if (typeof value !== 'string' || !identifierPattern.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export function validateTimestamp(value, label = 'timestamp') {
  if (!strictInstant(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export function validateRecordLinks(links = {}) {
  if (!plainObject(links) || Object.keys(links).some(key => !recordLinkKinds.includes(key))) throw new Error('Invalid record links');
  for (const [kind, ids] of Object.entries(links)) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw new Error(`Invalid ${kind} links`);
    ids.forEach(id => validateIdentifier(id, `${kind} link`));
  }
  return links;
}

export function validateEvidenceScope(scope) {
  if (!plainObject(scope)) throw new Error('Invalid evidence scope');
  for (const key of ['dataset', 'league_id', 'season']) {
    if (typeof scope[key] !== 'string' || !scope[key]) throw new Error(`Invalid evidence scope ${key}`);
  }
  const team = scope.team_id ?? null, matchup = scope.matchup_id ?? null;
  if (team !== null && (typeof team !== 'string' || !team)) throw new Error('Invalid evidence scope team_id');
  if (matchup !== null && (typeof matchup !== 'string' || !matchup)) throw new Error('Invalid evidence scope matchup_id');
  if (team !== null && matchup !== null) throw new Error('Evidence scope cannot name both a team and matchup');
  if (!plainObject(scope.scoring_period) || typeof scope.scoring_period.kind !== 'string' || !scope.scoring_period.kind || typeof scope.scoring_period.key !== 'string' || !scope.scoring_period.key || typeof scope.scoring_period.timezone !== 'string' || !scope.scoring_period.timezone) throw new Error('Invalid evidence scoring period');
  if (!plainObject(scope.value_basis) || typeof scope.value_basis.value !== 'string' || !scope.value_basis.value || typeof scope.value_basis.aggregation !== 'string' || !scope.value_basis.aggregation) throw new Error('Invalid evidence value basis');
  return scope;
}
export function numeric(value) {
  if (value == null || String(value).trim() === '') return null;
  const s = String(value).replaceAll(',', '').trim();
  return /^-?(?:\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : null;
}
export function validateStats(stats) {
  for (const [key, n] of Object.entries(stats)) {
    if (n !== null && (!Number.isFinite(n) || n < 0)) throw new Error(`Invalid statistic: ${key}`);
    if (key.endsWith('_pct') && n > 1) throw new Error('Invalid percentage');
  }
  for (const [made, attempts] of [['fgm', 'fga'], ['ftm', 'fta']]) {
    if (stats[made] != null && stats[attempts] != null && stats[made] > stats[attempts]) throw new Error('Shooting makes exceed attempts');
  }
  if (stats.oreb != null && stats.reb != null && stats.oreb > stats.reb) throw new Error('Offensive rebounds exceed rebounds');
  return stats;
}
export function sumStats(rows) {
  const stats = Object.fromEntries(countKeys.map(key => [key, rows.length && rows.every(r => r[key] != null) ? rows.reduce((s, r) => s + r[key], 0) : null]));
  stats.fg_pct = stats.fga > 0 && stats.fgm != null ? stats.fgm / stats.fga : null;
  stats.ft_pct = stats.fta > 0 && stats.ftm != null ? stats.ftm / stats.fta : null;
  return validateStats(stats);
}
