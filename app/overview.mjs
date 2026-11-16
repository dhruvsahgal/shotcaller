import { coverageOverview } from './coverage.mjs';
import { marketEvidence } from './market.mjs';
import { digest } from './store.mjs';
import { countKeys, categoryKeys } from './schema.mjs';
import { historicalShapeError } from './import-validation.mjs';
import { compareObservations, observationScopeKey } from './observations.mjs';

const statKeys = new Set([...countKeys, ...categoryKeys, 'st']);
const labels = {
  matchup_weekly_category_totals: 'Matchup category totals',
  standard_team_performance_check: 'Team performance check',
  daily_lineup_audit: 'Daily lineup audit',
  team_log_fantasy_earned_cumulative_stats: 'Historical Team Log',
  league_weekly_category_totals: 'Historical league category totals',
  roster_membership_observation: 'Roster membership observation',
  collected_documents: 'Reports and decision notes',
  league_capture: 'Browser league capture'
};

function observation(payload) {
  // Keep date-only and approximate source values intact. Upload time is not observation time.
  return [payload.observed_at, payload.captured_at, payload.source?.captured_at, payload.observed_date]
    .find(value => typeof value === 'string' && Number.isFinite(Date.parse(value))) ?? null;
}

function metadata(record, payload = record) {
  return {
    id: record.id,
    observed_at: observation(payload),
    observed_at_precision: payload.observed_at_precision ?? null,
    stored_at: record.stored_at ?? null,
    status: record.status ?? 'unknown',
    coverage: structuredClone(payload.coverage ?? { scope: payload.scope ?? null, warnings: payload.warnings ?? [] }),
    source_snapshot_id: payload.snapshot_id ?? null
  };
}

function time(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : -Infinity;
}
function latestStored(a, b) {
  const storedA = time(a.meta.stored_at), storedB = time(b.meta.stored_at);
  if (storedA !== storedB) return storedA > storedB ? -1 : 1;
  return String(a.meta.id).localeCompare(String(b.meta.id));
}
function recent(a, b) {
  const observedA = time(a.meta.observed_at), observedB = time(b.meta.observed_at);
  if (observedA !== observedB) return observedA > observedB ? -1 : 1;
  return latestStored(a, b);
}
function journalRecent(a, b) {
  const dateA = time(a.decided_on ?? a.created_at ?? a.meta.observed_at);
  const dateB = time(b.decided_on ?? b.created_at ?? b.meta.observed_at);
  return dateA === dateB ? latestStored(a, b) : dateA > dateB ? -1 : 1;
}

function statsOf(row) {
  const stats = Object.fromEntries(Object.entries(row).filter(([key]) => statKeys.has(key)));
  Object.assign(stats, row.stats, row.shooting);
  if (stats.stl === undefined && stats.st !== undefined) stats.stl = stats.st;
  delete stats.st;
  for (const prefix of ['fg', 'ft']) {
    const made = stats[`${prefix}m`], attempted = stats[`${prefix}a`];
    if (attempted === 0) stats[`${prefix}_pct`] = null;
    else if (Number.isFinite(made) && Number.isFinite(attempted)) stats[`${prefix}_pct`] = made / attempted;
  }
  return stats;
}

function normalizedRow(row) {
  const result = structuredClone(row);
  for (const key of statKeys) delete result[key];
  result.stats = statsOf(row);
  if (Array.isArray(row.players)) result.players = row.players.map(normalizedRow);
  return result;
}

const hasWeek = payload => Number.isInteger(Number(payload.week)) && Number(payload.week) > 0;
const matchupKinds = new Set(['matchup_weekly_category_totals', 'standard_team_performance_check']);

/** Read-only projection: immutable evidence stays separate from period-specific facts and decisions. */
function observationOverview(records, leagueId) {
  const historyPointer = record => ({ id: record.id, observed_at: record.observed_at, stored_at: record.stored_at, coverage: record.coverage, content_hash: record.content_hash });
  const scopes = new Map();
  for (const record of records) {
    if (record?.kind !== 'observation' || !record.scope) continue;
    if (leagueId !== null && String(record.scope.league_id) !== String(leagueId)) continue;
    const key = observationScopeKey(record.scope);
    if (!scopes.has(key)) scopes.set(key, []);
    scopes.get(key).push(record);
  }
  return {
    scopes: [...scopes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, history]) => {
      history.sort((a, b) => compareObservations(b, a));
      return {
        key,
        scope: structuredClone(history[0].scope),
        current: structuredClone(history.find(record => record.coverage?.status === 'complete') ?? null),
        latest: structuredClone(history[0]),
        history: history.slice(0, 5).map(historyPointer),
        history_count: history.length
      };
    })
  };
}

function collectionId(record) {
  return record?.data?.fragments?.find(fragment => typeof fragment?.collection_id === 'string')?.collection_id ?? null;
}

function hasRows(record) {
  if (Array.isArray(record?.data?.rows) && record.data.rows.length > 0) return true;
  return record?.data?.fragments?.some(fragment => Array.isArray(fragment?.rows) && fragment.rows.length > 0) ?? false;
}

function freshnessOverview(records, matchup) {
  const dated = records.filter(record => Number.isFinite(time(record?.observed_at))).sort((a, b) => time(b.observed_at) - time(a.observed_at));
  const newest = dated[0];
  if (!newest) return {
    latest_scan: null,
    structured_matchup_observed_at: matchup?.meta?.observed_at ?? null,
    matchup_is_older_than_scan: false
  };
  const id = collectionId(newest);
  const scan = id ? dated.filter(record => collectionId(record) === id) : [newest];
  const usable = scan.filter(hasRows).length;
  const statuses = scan.map(record => record.coverage?.status);
  const status = statuses.length && statuses.every(value => value === 'complete') ? 'complete' : statuses.includes('partial') ? 'partial' : 'unknown';
  const structured = matchup?.meta?.observed_at ?? null;
  return {
    latest_scan: {
      collection_id: id,
      observed_at: newest.observed_at,
      status,
      segments: scan.length,
      usable_segments: usable,
      empty_segments: scan.length - usable
    },
    structured_matchup_observed_at: structured,
    matchup_is_older_than_scan: Number.isFinite(time(structured)) && time(newest.observed_at) > time(structured)
  };
}

export function buildOverview(records = [], decisions = [], leagueId = null, observations = [], intelligence = {}) {
  const scopedObservations = new Map();
  for (const record of [...records, ...observations]) {
    if (record?.kind === 'observation') scopedObservations.set(record.id, record);
  }
  const allEntries = records.filter(record => record?.kind !== 'observation').map(record => {
    const payload = record.kind === 'historical_import' ? record.payload : record;
    return { record, payload, meta: metadata(record, payload) };
  }).filter(({ payload }) => leagueId === null || payload.league_id == null || String(payload.league_id) === String(leagueId)).sort(recent);

  const entries = allEntries.filter(({ payload }) => !historicalShapeError(payload));
  const sources = allEntries.map(({ record, payload, meta }) => ({
    ...meta, label: labels[payload.kind] ?? payload.original_path ?? payload.kind ?? 'Unclassified evidence', kind: payload.kind ?? record.kind, validation_error: historicalShapeError(payload)
  }));
  const latest = predicate => entries.find(({ payload }) => predicate(payload));
  const playerSection = entry => entry ? { meta: entry.meta, players: entry.payload.players.map(normalizedRow) } : null;
  const teamSection = entry => entry ? { meta: entry.meta, week: Number(entry.payload.week), teams: entry.payload.teams.map(normalizedRow) } : null;

  const matchupHistory = entries.filter(({ payload }) => matchupKinds.has(payload.kind) && hasWeek(payload) && Array.isArray(payload.teams)).map(teamSection);
  const scopedForLeague = [...scopedObservations.values()].filter(record => leagueId === null || record.scope?.league_id === String(leagueId));
  const freshness = freshnessOverview(scopedForLeague, matchupHistory[0] ?? null);
  const league = teamSection(latest(payload => payload.kind === 'league_weekly_category_totals' && hasWeek(payload) && Array.isArray(payload.teams)));
  const roster = playerSection(latest(payload => payload.kind === 'roster_membership_observation' && Array.isArray(payload.players)));
  const teamLogEntry = latest(payload => payload.kind === 'team_log_fantasy_earned_cumulative_stats' && Array.isArray(payload.players));
  const teamLog = playerSection(teamLogEntry);
  if (teamLog && teamLogEntry.payload.reported_totals) teamLog.reported_totals = statsOf(teamLogEntry.payload.reported_totals);

  const lineupDays = new Map();
  let lineupMeta = null;
  for (const { payload, meta } of entries) {
    const days = payload.kind === 'daily_lineup_audit' ? payload.days : payload.kind === 'standard_team_performance_check' ? payload.remaining_lineups : null;
    if (!Array.isArray(days)) continue;
    lineupMeta ??= meta;
    for (const day of days) {
      if (typeof day.date === 'string' && !lineupDays.has(day.date)) lineupDays.set(day.date, { ...structuredClone(day), meta });
    }
  }

  const waiverEntry = latest(payload => payload.kind === 'standard_team_performance_check' && Array.isArray(payload.waiver_candidates_season_averages));
  const waivers = waiverEntry ? { meta: waiverEntry.meta, players: waiverEntry.payload.waiver_candidates_season_averages.map(normalizedRow) } : null;
  const statusEntry = latest(payload => payload.kind === 'standard_team_performance_check' && payload.roster_status);
  const recommendationEntry = latest(payload => payload.kind === 'standard_team_performance_check' && payload.recommendation);

  const transactions = new Map();
  for (const { payload, meta } of entries) {
    if (!Array.isArray(payload.recent_transactions)) continue;
    for (const [index, row] of payload.recent_transactions.entries()) {
      const identity = [row.displayed_at ?? null, row.team ?? null, row.add ?? null, row.drop ?? null];
      const providerId = row.provider_transaction_id ?? row.transaction_key ?? row.transaction_id;
      const key = typeof providerId === 'string' && providerId ? ['provider', payload.league_id ?? leagueId, providerId] : identity[0] && identity[1] && (identity[2] || identity[3]) ? ['displayed', ...identity] : ['observation', meta.id, index];
      const id = `transaction-${digest(key).slice(0, 24)}`;
      const existing = transactions.get(id);
      if (existing) {
        if (!existing.observations.some(observed => observed.id === meta.id)) existing.observations.push(meta);
      } else {
        transactions.set(id, { id, displayed_at: identity[0], team: identity[1], add: identity[2], drop: identity[3], meta, observations: [meta] });
      }
    }
  }

  const documents = new Map(), journal = new Map();
  const bundles = entries.filter(({ payload }) => payload.kind === 'collected_documents').sort(latestStored);
  for (const { payload, meta } of bundles) {
    for (const document of payload.documents ?? []) {
      if (typeof document.path === 'string' && !documents.has(document.path)) documents.set(document.path, { ...structuredClone(document), meta });
    }
    for (const decision of payload.journal ?? []) {
      const key = digest(decision);
      if (!journal.has(key)) journal.set(key, { ...structuredClone(decision), meta });
    }
  }
  for (const decision of decisions) {
    if (leagueId !== null && decision.league_id != null && String(decision.league_id) !== String(leagueId)) continue;
    journal.set(decision.id ?? digest(decision), { ...structuredClone(decision), meta: metadata(decision) });
  }

  const gaps = [
    'This view reads saved evidence; it does not automatically sync Yahoo or establish monitoring.',
    'Archival chat coverage is incomplete: earlier screenshots and discussions are not all structured observations.',
    'No verified current full-league category capture is projected here; historical league totals are a separate baseline.'
  ];
  if (allEntries.length !== entries.length) gaps.push('Some archived records have invalid table shapes. They remain in Evidence but are excluded from the consolidated tables.');
  if (!roster) gaps.push('No explicit roster membership observation is saved. Team Log player rows cannot establish current ownership.');
  if (teamLog) gaps.push('Historical Team Log coverage may lag the matchup and include former roster members; do not combine it with weekly totals.');
  if (league) gaps.push(`League comparison is historical Week ${league.week}; its totals are not a current strength forecast.`);
  if (entries.some(({ meta }) => meta.observed_at === null)) gaps.push('Some evidence has an unknown observation date; storage time is shown separately and is not used as an observation date.');
  if (entries.some(({ record }) => record.kind === 'league_capture')) gaps.push('Raw browser captures remain linked evidence. Their unverified period or completeness cannot replace confirmed-week category totals.');
  if (waivers) gaps.push('Waiver candidates are an observed subset, not a complete or continuously current availability list.');
  if (transactions.size) gaps.push('Transaction times are preserved as Yahoo displayed them; timezone and full-history completeness are not established.');
  if (recommendationEntry) gaps.push('The displayed recommendation is saved reasoning from its observation date, not a newly evaluated or executed move.');
  if (freshness.matchup_is_older_than_scan) {
    const scan = freshness.latest_scan;
    gaps.push(`A newer scan was captured at ${scan.observed_at}, but ${scan.empty_segments} of ${scan.segments} segments had no normalized rows. The structured matchup remains the older dated record.`);
  }

  return {
    dataset_coverage: coverageOverview(scopedForLeague),
    market_evidence: marketEvidence([...entries.map(entry => entry.record), ...scopedForLeague]),
    freshness,
    sources, matchup: matchupHistory[0] ?? null, matchup_history: matchupHistory, observations: observationOverview([...scopedObservations.values()], leagueId),
    lineups: lineupMeta ? { meta: lineupMeta, days: [...lineupDays.values()].sort((a, b) => a.date.localeCompare(b.date)) } : null,
    roster, team_log: teamLog, league, waivers, transactions: [...transactions.values()],
    status: statusEntry ? { ...structuredClone(statusEntry.payload.roster_status), meta: statusEntry.meta } : null,
    recommendation: recommendationEntry ? { ...structuredClone(recommendationEntry.payload.recommendation), meta: recommendationEntry.meta } : null,
    documents: [...documents.values()].sort((a, b) => a.path.localeCompare(b.path)), journal: [...journal.values()].sort(journalRecent),
    intelligence: structuredClone(intelligence), gaps
  };
}
