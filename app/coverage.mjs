import { canonicalDigest } from './store.mjs';
import { validateEvidenceScope, validateStats } from './schema.mjs';
import { strictInstant, validDate } from './time.mjs';

export const coverageDatasets = Object.freeze(['team_roster', 'matchups', 'team_period_stats', 'player_period_stats', 'daily_lineup', 'daily_contributions', 'market', 'transactions']);
const equal = (a, b) => canonicalDigest(a) === canonicalDigest(b);
const uniqueStrings = items => Array.isArray(items) && items.every(item => typeof item === 'string' && item.length > 0) && new Set(items).size === items.length;
const dayAfter = date => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/** The manifest declares what must be seen before collection starts; observed pages cannot shrink it. */
export function createCoveragePlan({ league_id, season, scoring_period, team_ids, matchups, scoring_dates, transaction_window }) {
  if (!uniqueStrings(team_ids) || team_ids.length !== 10) throw new Error('Coverage requires ten distinct team IDs');
  if (!Array.isArray(matchups) || matchups.length !== 5 || !uniqueStrings(matchups.map(m => m.id)) || !matchups.every(m => uniqueStrings(m.team_ids) && m.team_ids.length === 2) || !equal(matchups.flatMap(m => m.team_ids).sort(), [...team_ids].sort())) throw new Error('Coverage requires five pairings covering every team once');
  if (!Array.isArray(scoring_dates) || scoring_dates.length !== 7 || !scoring_dates.every((date, i) => validDate(date) && (!i || date === dayAfter(scoring_dates[i - 1])))) throw new Error('Coverage requires seven consecutive scoring dates');
  if (!transaction_window || !strictInstant(transaction_window.start) || !strictInstant(transaction_window.end) || Date.parse(transaction_window.start) >= Date.parse(transaction_window.end)) throw new Error('Invalid transaction window');
  const segments = [];
  function add(dataset, { team_id = null, matchup_id = null, date = null, filters = {}, expected_team_ids = null } = {}) {
    const scope = { dataset, league_id, season, team_id, matchup_id, scoring_period: date ? { kind: 'date', key: date, timezone: scoring_period.timezone } : scoring_period, value_basis: { value: 'actual', aggregation: ['team_period_stats', 'player_period_stats', 'daily_contributions', 'matchups'].includes(dataset) ? 'totals' : 'snapshot' } };
    validateEvidenceScope(scope);
    const segment = { scope, filters, expected_team_ids };
    segments.push({ id: `segment-${canonicalDigest(segment).slice(0, 24)}`, ...segment });
  }
  for (const team_id of team_ids) {
    add('team_roster', { team_id });
    add('player_period_stats', { team_id });
    for (const date of scoring_dates) {
      add('daily_lineup', { team_id, date });
      add('daily_contributions', { team_id, date, filters: { fantasy_counted: true, include_dropped: true } });
    }
  }
  for (const matchup of matchups) add('matchups', { matchup_id: matchup.id, expected_team_ids: [...matchup.team_ids].sort() });
  add('team_period_stats', { expected_team_ids: [...team_ids].sort() });
  for (const availability of ['FA', 'W']) add('market', { filters: { availability } });
  add('transactions', { filters: { ...transaction_window, include: ['confirmed', 'requested', 'rejected', 'cancelled'] } });
  return { version: 1, league_id, season, scoring_period, matchups: structuredClone(matchups), transaction_window: structuredClone(transaction_window), scoring_dates: [...scoring_dates], team_ids: [...team_ids], segments };
}

function fragmentIssues(segment, fragment) {
  const issues = [];
  let restartRequired = false;
  const add = (message, restart = true) => { issues.push(message); restartRequired ||= restart; };
  if (!fragment || typeof fragment !== 'object') return { issues: ['Invalid fragment'], restartRequired: true };
  if (typeof fragment.id !== 'string' || !fragment.id || typeof fragment.collection_id !== 'string' || !fragment.collection_id || fragment.segment_id !== segment.id) add('Fragment identity mismatch');
  if (!equal(fragment.scope ?? null, segment.scope) || !equal(fragment.filters ?? {}, segment.filters)) add('Fragment period, scope or filter mismatch');
  if (!strictInstant(fragment.observed_at) || !fragment.source?.id || !/^[a-f0-9]{64}$/.test(fragment.source?.hash ?? '') || !Array.isArray(fragment.evidence_refs) || !fragment.evidence_refs.length || fragment.evidence_refs.some(ref => typeof ref !== 'string' || !ref.trim())) add('Missing dated source evidence');
  if (!['complete', 'partial', 'unknown'].includes(fragment.status)) add('Invalid fragment status');
  if (typeof fragment.page_key !== 'string' || !fragment.page_key || !Array.isArray(fragment.rows)) add('Missing page key or rows');
  if (fragment.terminal !== true && (typeof fragment.next_page_key !== 'string' || !fragment.next_page_key)) add('Missing terminal or next-page evidence');
  if (fragment.terminal === true && fragment.next_page_key != null) add('Terminal page also has a next-page key');
  if (fragment.reported_total_rows != null && (!Number.isSafeInteger(fragment.reported_total_rows) || fragment.reported_total_rows < 0)) add('Invalid reported row total');
  for (const row of Array.isArray(fragment.rows) ? fragment.rows : []) {
    if (!row || typeof row !== 'object') { add('Invalid source row'); continue; }
    const dataset = segment.scope.dataset;
    if (['team_roster', 'player_period_stats', 'daily_lineup', 'daily_contributions', 'market'].includes(dataset) && (typeof row.player_id !== 'string' || !row.player_id)) add('Missing player identity');
    if (['matchups', 'team_period_stats'].includes(dataset) && (typeof row.team_id !== 'string' || !row.team_id)) add('Missing team identity');
    if (row.team_id && segment.scope.team_id && row.team_id !== segment.scope.team_id) add('Row team mismatch');
    if (dataset === 'market' && row.availability !== segment.filters.availability) add('Row availability mismatch');
    if (dataset === 'daily_lineup' && (typeof row.slot !== 'string' || !row.slot)) add('Missing lineup slot');
    if (dataset === 'daily_contributions' && (row.fantasy_counted !== true || !row.stats)) add('Daily contributions need explicit fantasy-counted source rows');
    if (['player_period_stats', 'team_period_stats', 'matchups'].includes(dataset) && !row.stats) add('Missing period statistics');
    if (row.stats) { try { validateStats(row.stats); } catch { add('Invalid source statistics'); } }
  }
  return { issues: [...new Set(issues)], restartRequired };
}

/** One run's fragments only. Mixing dates/filters, repeated pages, or an unproven terminal never completes a segment. */
export function assessSegment(segment, fragments = []) {
  if (!Array.isArray(fragments)) throw new Error('Invalid segment fragments');
  if (fragments.some(fragment => !fragment || typeof fragment !== 'object' || Array.isArray(fragment))) return { segment_id: segment.id, status: 'partial', issues: ['Invalid fragment'], rows: [], evidence_ids: [], resume_page_key: null };
  if (!fragments.length) return { segment_id: segment.id, status: 'unknown', issues: ['No source capture'], rows: [], evidence_ids: [], resume_page_key: 'first' };
  const validations = fragments.map(fragment => fragmentIssues(segment, fragment));
  const issues = validations.flatMap(result => result.issues);
  let restartRequired = validations.some(result => result.restartRequired);
  if (new Set(fragments.map(fragment => fragment.collection_id)).size !== 1) { issues.push('Fragment collection run mismatch'); restartRequired = true; }
  const pages = new Map();
  for (const fragment of fragments) {
    if (pages.has(fragment.page_key)) { issues.push('Repeated pagination page'); restartRequired = true; }
    pages.set(fragment.page_key, fragment);
  }
  const ordered = [], visited = new Set();
  let cursor = 'first', terminal = false;
  while (pages.has(cursor) && !visited.has(cursor)) {
    visited.add(cursor);
    const fragment = pages.get(cursor); ordered.push(fragment);
    if (fragment.status !== 'complete') issues.push('Source page is incomplete');
    if (fragment.terminal === true) { terminal = true; cursor = null; break; }
    cursor = fragment.next_page_key;
  }
  if (!terminal) {
    if (visited.has(cursor)) { issues.push('Pagination loop'); restartRequired = true; }
    else issues.push('Terminal page not captured');
  }
  if (visited.size !== pages.size) { issues.push('Unlinked pagination fragments'); restartRequired = true; }
  const rows = ordered.flatMap(page => Array.isArray(page.rows) ? page.rows : []);
  const rowKey = row => segment.scope.dataset === 'transactions' ? row?.provider_event_id ?? row?.transaction_id ?? null : row?.player_id ?? row?.team_id ?? null;
  const keys = rows.map(rowKey).filter(Boolean);
  if (new Set(keys).size !== keys.length) { issues.push('Repeated row across pagination'); restartRequired = true; }
  const totals = fragments.map(fragment => fragment.reported_total_rows).filter(value => value != null);
  if (terminal && totals.some(total => total !== rows.length)) { issues.push('Visible row total mismatch'); restartRequired = true; }
  if (segment.expected_team_ids && !equal(rows.map(row => row?.team_id).sort(), segment.expected_team_ids)) { issues.push('Required teams or matchup pairing missing'); restartRequired = true; }
  const uniqueIssues = [...new Set(issues)];
  return { segment_id: segment.id, status: uniqueIssues.length ? 'partial' : 'complete', issues: uniqueIssues, rows: structuredClone(rows), evidence_ids: fragments.map(fragment => fragment.id), resume_page_key: terminal || restartRequired ? null : cursor || 'first' };
}

export function assessCoverage(plan, fragments = []) {
  const segments = plan.segments.map(segment => ({ dataset: segment.scope.dataset, scope: segment.scope, filters: segment.filters, ...assessSegment(segment, fragments.filter(fragment => fragment.segment_id === segment.id)) }));
  const datasets = coverageDatasets.map(dataset => {
    const members = segments.filter(segment => segment.dataset === dataset);
    return { dataset, status: members.length && members.every(s => s.status === 'complete') ? 'complete' : members.every(s => s.status === 'unknown') ? 'unknown' : 'partial', expected_segments: members.length, complete_segments: members.filter(s => s.status === 'complete').length };
  });
  const unexpected_fragments = fragments.filter(fragment => !plan.segments.some(segment => segment.id === fragment.segment_id)).map(fragment => fragment.id);
  return { status: !unexpected_fragments.length && datasets.every(d => d.status === 'complete') ? 'complete' : fragments.length ? 'partial' : 'unknown', datasets, segments, unexpected_fragments };
}

export function pendingSegments(plan, fragments = []) {
  const coverage = assessCoverage(plan, fragments);
  return coverage.segments.filter(segment => segment.status !== 'complete').map(segment => ({ ...plan.segments.find(s => s.id === segment.segment_id), resume_page_key: segment.resume_page_key, restart_required: segment.resume_page_key === null, issues: segment.issues }));
}

/** Daily rows stay tied to their original starts; current roster membership is deliberately not an input. */
export function dailyContributions(plan, fragments = []) {
  return assessCoverage(plan, fragments).segments.filter(segment => segment.dataset === 'daily_contributions').map(segment => ({ team_id: segment.scope.team_id, scoring_date: segment.scope.scoring_period.key, status: segment.status, evidence_ids: segment.evidence_ids, players: segment.rows }));
}

export function createPilotAudit({ start_date, scheduled_attempts, sample_seed }) {
  if (!validDate(start_date) || !Array.isArray(scheduled_attempts) || !sample_seed) throw new Error('Invalid pilot audit plan');
  const dates = [start_date]; while (dates.length < 7) dates.push(dayAfter(dates.at(-1)));
  if (!scheduled_attempts.length || scheduled_attempts.some(a => !a.id || !dates.includes(a.scoring_date)) || dates.some(date => scheduled_attempts.filter(a => a.scoring_date === date).length !== 2) || new Set(scheduled_attempts.map(a => a.id)).size !== scheduled_attempts.length) throw new Error('Invalid pilot scheduled attempts');
  return { version: 1, start_date, dates, sample_seed, scheduled_attempts: structuredClone(scheduled_attempts), matrix: dates.flatMap(date => coverageDatasets.map(dataset => ({ date, dataset }))) };
}

/** Deterministic pseudorandom sampling fixed by the preregistered seed; every routine run gets rows and totals checks. */
export function selectAuditSamples(audit, attempt_id, fragments) {
  return coverageDatasets.flatMap(dataset => {
    const pages = fragments.filter(fragment => fragment.scope?.dataset === dataset);
    const candidates = pages.flatMap(page => (page.rows ?? []).map((_, index) => ({ evidence_id: page.id, row_index: index })));
    const rank = value => canonicalDigest({ seed: audit.sample_seed, attempt_id, dataset, value });
    candidates.sort((a, b) => rank(a).localeCompare(rank(b)));
    return [{ dataset, rows: candidates.slice(0, 3), totals: pages.map(page => page.id).sort((a, b) => rank(a).localeCompare(rank(b))).slice(0, 1) }];
  });
}

export function pilotReport(audit, attempts = []) {
  const scheduled = audit.scheduled_attempts.map(slot => ({ ...slot, result: attempts.find(attempt => attempt.id === slot.id) ?? null }));
  const matrix = audit.matrix.map(cell => {
    const observed = scheduled.filter(slot => slot.scoring_date === cell.date).flatMap(slot => slot.result?.coverage?.datasets?.filter(d => d.dataset === cell.dataset) ?? []);
    return { ...cell, status: observed.length && observed.every(d => d.status === 'complete') ? 'complete' : observed.length ? 'partial' : 'unknown' };
  });
  const failures = [];
  for (const slot of scheduled) {
    const attempt = slot.result;
    if (!attempt) { failures.push(`${slot.id}: missing attempt (access/capacity not established)`); continue; }
    if (attempt.coverage?.status !== 'complete') failures.push(`${slot.id}: incomplete collection`);
    if (attempt.outcome !== 'complete') failures.push(`${slot.id}: ${attempt.outcome ?? 'unknown outcome'}`);
    if (!attempt.independent_review?.reviewer_id || !strictInstant(attempt.independent_review?.reviewed_at) || !attempt.independent_review?.passed || attempt.independent_review?.source_compared !== true || attempt.independent_review?.sample_seed !== audit.sample_seed || !coverageDatasets.every(dataset => attempt.independent_review.datasets_checked?.includes(dataset))) failures.push(`${slot.id}: independent source comparison incomplete`);
    if (attempt.partial_to_complete && attempt.independent_review?.transition_checked !== true) failures.push(`${slot.id}: coverage transition not independently reviewed`);
    for (const key of ['runtime_ms', 'token_count', 'compute_cost', 'login_interventions']) if (!Number.isFinite(attempt[key]) || attempt[key] < 0) failures.push(`${slot.id}: missing ${key}`);
    if (attempt.independent_review?.mismatches?.length) failures.push(`${slot.id}: source mismatch; restart seven-day window`);
  }
  if (matrix.some(cell => cell.status !== 'complete')) failures.push('Seven-day dataset evidence matrix is incomplete');
  return { status: failures.length ? 'not_passed' : 'passed', requires_external_review: true, matrix, scheduled_attempts: scheduled, unscheduled_attempts: attempts.filter(attempt => !scheduled.some(slot => slot.id === attempt.id)), failures };
}

/** The adapter can publish these inputs with Store.saveObservation; raw fragments remain linked evidence. */
export function segmentObservation({ id, segment, fragments, source_id }) {
  if (!fragments.length) throw new Error('Cannot publish a segment without evidence');
  const assessment = assessSegment(segment, fragments);
  const observed_at = fragments.map(fragment => fragment.observed_at).filter(strictInstant).sort().at(-1);
  if (!observed_at) throw new Error('Cannot publish undated dataset fragments');
  return { id, source: { id: source_id, hash: canonicalDigest(fragments) }, observed_at, observed_at_precision: 'instant', scope: structuredClone(segment.scope), coverage: { status: assessment.status, note: assessment.issues.join('; ') || 'Every declared source page and required entity captured.' }, parser_version: 'dataset-segment-v1', data: { segment_id: segment.id, filters: segment.filters, rows: assessment.rows, fragments: structuredClone(fragments) }, links: { evidence: [...new Set(fragments.map(fragment => fragment.source.id))] } };
}

export function coverageOverview(records = []) {
  const unknownCoverage = (observation_id, note) => ({ status: 'unknown', observation_id, datasets: coverageDatasets.map(dataset => ({ dataset, status: 'unknown', complete_segments: 0, expected_segments: null })), note });
  const latest = records.filter(record => record.kind === 'observation' && record.scope?.dataset === 'league_coverage' && record.data?.plan && Array.isArray(record.data?.fragments)).sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)))[0];
  if (!latest) return unknownCoverage(null, 'Full-league segment routing and live seven-day pilot have not been verified.');
  let result;
  try {
    const declared = createCoveragePlan(latest.data.plan);
    if (declared.league_id !== latest.scope.league_id || declared.season !== latest.scope.season || !equal(declared.segments, latest.data.plan.segments)) throw new Error('Coverage manifest scope mismatch');
    result = assessCoverage(declared, latest.data.fragments);
  } catch {
    return unknownCoverage(latest.id, 'Saved coverage manifest is invalid; its claims are excluded.');
  }
  return { ...result, observation_id: latest.id, observed_at: latest.observed_at, note: 'Dataset completeness is scoped to this saved collection. It does not establish live pilot accuracy or freshness.' };
}
