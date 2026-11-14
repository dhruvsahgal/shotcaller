import { canonicalDigest } from './store.mjs';
import { categoryKeys } from './schema.mjs';
import { unique } from './evaluate.mjs';
import { categoryValue, missingCategories } from './categories.mjs';

const allPlay = matchups => {
  const teams = matchups.flatMap(row => row.teams || []);
  return teams.map(team => ({
    team_id: team.id, name: team.name,
    category_ranks: Object.fromEntries(categoryKeys.map(category => {
      const sorted = teams.map(row => ({ id: row.id, value: categoryValue(row.stats, category) })).filter(row => Number.isFinite(row.value)).sort((a, b) => b.value - a.value);
      const index = sorted.findIndex(row => row.id === team.id);
      return [category, index < 0 ? null : index + 1];
    })),
    all_play: teams.filter(other => other.id !== team.id).reduce((record, other) => {
      let won = 0, lost = 0, tied = 0, compared = 0;
      for (const category of categoryKeys) {
        const own = categoryValue(team.stats, category), theirs = categoryValue(other.stats, category);
        if (!Number.isFinite(own) || !Number.isFinite(theirs)) continue;
        compared++;
        if (own > theirs) won++; else if (own < theirs) lost++; else tied++;
      }
      if (!compared) { record.incomplete++; return record; }
      if (won > lost) record.wins++; else if (won < lost) record.losses++; else record.ties++;
      return record;
    }, { wins: 0, losses: 0, ties: 0, incomplete: 0 })
  }));
};

const duplicates = values => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();
const sortedIds = values => values.filter(value => typeof value === 'string' && value).sort();
const sameIds = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

function reportTopology(input, context) {
  const expected = Array.isArray(context.frozen_matchup_topology) ? context.frozen_matchup_topology : [];
  const expectedIds = expected.map(row => row?.id).filter(Boolean);
  const actualIds = input.matchups.map(row => row?.id).filter(Boolean);
  const issues = [];
  if (!expected.length || typeof context.matchup_topology_source_id !== 'string' || !context.matchup_topology_source_id) issues.push('Frozen matchup topology and its source ID are required before the report can be final.');
  if (expectedIds.length !== expected.length || duplicates(expectedIds).length) issues.push('Frozen matchup topology has missing or duplicate matchup IDs.');
  if (duplicates(actualIds).length) issues.push('Observed matchups contain duplicate IDs.');
  if (!sameIds(sortedIds(expectedIds), sortedIds(actualIds))) issues.push('Observed matchup IDs do not exactly match the frozen topology.');
  const expectedTeams = expected.flatMap(row => Array.isArray(row?.team_ids) ? row.team_ids : []);
  if (expected.some(row => !Array.isArray(row?.team_ids) || row.team_ids.length !== 2 || new Set(row.team_ids).size !== 2) || duplicates(expectedTeams).length) issues.push('Frozen matchup topology must assign each team to one two-team matchup.');
  const actualById = new Map(input.matchups.map(row => [row?.id, row]));
  for (const matchup of expected) {
    const actual = actualById.get(matchup?.id);
    if (!actual) continue;
    const actualTeams = sortedIds((actual.teams || []).map(row => row?.id));
    if (duplicates(actualTeams).length || !sameIds(sortedIds(matchup.team_ids || []), actualTeams)) issues.push(`Observed teams do not match frozen matchup ${matchup.id}.`);
  }
  if (input.matchups.some(row => row?.status !== 'final')) issues.push('One or more observed matchups are not final.');
  return { complete: issues.length === 0, expected_matchup_ids: unique(expectedIds), observed_matchup_ids: unique(actualIds), issues };
}

function categoryCoverage(matchups) {
  const missing = matchups.flatMap(matchup => (matchup.teams || []).flatMap(team => missingCategories(team.stats).map(category => ({ matchup_id: matchup.id, team_id: team.id, category }))));
  return { complete: missing.length === 0, expected_observations: matchups.reduce((sum, row) => sum + (row.teams?.length || 0), 0) * categoryKeys.length, missing };
}

const appliedOutcome = outcome => outcome?.kind === 'action_outcome' && outcome?.execution_mode === 'live' && outcome?.outcome === 'applied' && !outcome?.requires_reconciliation && outcome?.id && outcome?.intent_id && outcome?.attempt_id && Array.isArray(outcome?.before_evidence_ids) && outcome.before_evidence_ids.length > 0 && Array.isArray(outcome?.after_evidence_ids) && outcome.after_evidence_ids.length > 0;

export function buildWeeklyReport(input, trustedContext = {}) {
  if (!input?.league_id || !input?.season || !Number.isInteger(input.week) || !Array.isArray(input.matchups)) throw new Error('Invalid weekly report input');
  const topology = reportTopology(input, trustedContext);
  const categories = categoryCoverage(input.matchups);
  const trustedOutcomes = trustedContext.action_outcomes || [];
  const outcomeDuplicates = new Set(duplicates(trustedOutcomes.map(row => row?.id).filter(Boolean)));
  const outcomes = new Map(trustedOutcomes.filter(row => appliedOutcome(row) && !outcomeDuplicates.has(row.id)).map(row => [row.id, row]));
  const trustedLinks = trustedContext.decision_action_links || [];
  const duplicatedDecisions = new Set(duplicates(trustedLinks.map(row => row?.decision_id).filter(Boolean)));
  const duplicatedOutcomes = new Set(duplicates(trustedLinks.map(row => row?.outcome_id).filter(Boolean)));
  const links = new Map(trustedLinks.filter(row => row?.decision_id && row?.intent_id && row?.outcome_id && !duplicatedDecisions.has(row.decision_id) && !duplicatedOutcomes.has(row.outcome_id)).map(row => [row.decision_id, row]));
  const verified = [], unexecuted = [];
  for (const decision of input.decisions || []) {
    const link = links.get(decision.id), outcome = outcomes.get(link?.outcome_id);
    if (link && outcome && link.intent_id === outcome.intent_id) verified.push({ decision_id: decision.id, intent_id: outcome.intent_id, outcome_id: outcome.id, attempt_id: outcome.attempt_id, status: 'applied' });
    else unexecuted.push({ id: decision.id, task: decision.task, status: 'advice_only' });
  }
  const lostDays = (input.lineup_days || []).map(row => ({ date: row.date, players: row.benched_with_game || [], count: (row.benched_with_game || []).length, source_snapshot_ids: row.source_snapshot_ids || [] })).filter(row => row.count);
  const recap = input.recap_decision ? { decision_id: input.recap_decision.id, text: input.recap_decision.answer, status: 'draft', authorized_for_sending: false } : null;
  const sourceSnapshotIds = unique([
    ...input.matchups.flatMap(row => row.source_snapshot_ids || []),
    ...(input.evaluations || []).flatMap(row => row.source_snapshot_ids || row.evaluation?.source_snapshot_ids || []),
    ...trustedOutcomes.flatMap(row => [...(row.before_evidence_ids || []), ...(row.after_evidence_ids || [])]),
    ...(input.lineup_days || []).flatMap(row => row.source_snapshot_ids || []),
    ...(input.recap_decision?.snapshot_ids || [])
  ]);
  const caveats = [...topology.issues];
  if (!categories.complete) caveats.push(`${categories.missing.length} category observations are missing; percentage categories require finite makes and attempts.`);
  const status = !topology.complete ? 'provisional' : categories.complete ? 'final' : 'partial';
  const report = {
    schema_version: 1, kind: 'weekly_report', status,
    league_id: String(input.league_id), season: String(input.season), week: input.week,
    created_at: input.created_at || new Date().toISOString(), correction_of: input.correction_of || null,
    season_history_ids: unique(trustedContext.season_history_ids || []), previous_report_id: trustedContext.previous_report_id || null,
    matchup_topology_source_id: trustedContext.matchup_topology_source_id || null,
    expected_matchups: topology.expected_matchup_ids.length, finalized_matchups: input.matchups.filter(row => row.status === 'final').length,
    topology_coverage: topology, category_coverage: categories,
    source_snapshot_ids: sourceSnapshotIds, matchups: structuredClone(input.matchups),
    evaluation_ids: (input.evaluations || []).map(row => row.id).filter(Boolean), all_play: allPlay(input.matchups.filter(row => row.status === 'final')),
    lost_starts: { total: lostDays.reduce((sum, row) => sum + row.count, 0), days: lostDays },
    decision_review: { verified, unexecuted }, recap,
    caveats
  };
  report.input_hash = canonicalDigest({ league_id: report.league_id, season: report.season, week: report.week, correction_of: report.correction_of, season_history_ids: report.season_history_ids, previous_report_id: report.previous_report_id, matchup_topology_source_id: report.matchup_topology_source_id, source_snapshot_ids: report.source_snapshot_ids, matchups: report.matchups, topology_coverage: report.topology_coverage, category_coverage: report.category_coverage, evaluation_ids: report.evaluation_ids, verified_outcomes: verified.map(row => row.outcome_id) });
  return report;
}

export function renderWeeklyReport(report) {
  const title = `# Week ${report.week} — ${report.status.toUpperCase()} review`;
  const correction = report.correction_of ? `\n\nCorrects: ${report.correction_of}` : '';
  const sources = report.source_snapshot_ids.length ? report.source_snapshot_ids.join(', ') : 'none recorded';
  const caveats = report.caveats.length ? `\n\n## Caveats\n\n${report.caveats.map(row => `- ${row}`).join('\n')}` : '';
  const recap = report.recap ? `\n\n## League recap draft\n\n${report.recap.text}\n\nStatus: draft; sending requires separate authorization.` : '';
  return `${title}${correction}\n\nFinalized matchups: ${report.finalized_matchups}/${report.expected_matchups}\n\nLost usable starts: ${report.lost_starts.total}\n\nVerified decision actions: ${report.decision_review.verified.length}\n\nUnexecuted recommendations: ${report.decision_review.unexecuted.length}\n\nSources: ${sources}${caveats}${recap}\n`;
}
