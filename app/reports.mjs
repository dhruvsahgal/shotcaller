import { canonicalDigest } from './store.mjs';
import { categoryKeys } from './schema.mjs';
import { unique } from './evaluate.mjs';

const categoryValue = (stats, category) => {
  if (category === 'fg_pct') return stats?.fg_pct ?? (stats?.fga > 0 ? stats.fgm / stats.fga : null);
  if (category === 'ft_pct') return stats?.ft_pct ?? (stats?.fta > 0 ? stats.ftm / stats.fta : null);
  return category === 'stl' ? stats?.stl ?? stats?.st : stats?.[category];
};
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
      let won = 0, lost = 0, tied = 0;
      for (const category of categoryKeys) {
        const own = categoryValue(team.stats, category), theirs = categoryValue(other.stats, category);
        if (!Number.isFinite(own) || !Number.isFinite(theirs)) continue;
        if (own > theirs) won++; else if (own < theirs) lost++; else tied++;
      }
      if (won > lost) record.wins++; else if (won < lost) record.losses++; else record.ties++;
      return record;
    }, { wins: 0, losses: 0, ties: 0 })
  }));
};

export function buildWeeklyReport(input) {
  if (!input?.league_id || !input?.season || !Number.isInteger(input.week) || !Array.isArray(input.matchups)) throw new Error('Invalid weekly report input');
  const expected = input.expected_matchups ?? 5;
  const final = input.matchups.length === expected && input.matchups.every(row => row.status === 'final');
  const actionsByDecision = new Map((input.actions || []).filter(row => row.status === 'verified' && row.decision_id).map(row => [row.decision_id, row]));
  const verified = [], unexecuted = [];
  for (const decision of input.decisions || []) {
    const action = actionsByDecision.get(decision.id);
    if (action) verified.push({ decision_id: decision.id, action_id: action.id, status: 'verified' });
    else unexecuted.push({ id: decision.id, task: decision.task, status: 'advice_only' });
  }
  const lostDays = (input.lineup_days || []).map(row => ({ date: row.date, players: row.benched_with_game || [], count: (row.benched_with_game || []).length, source_snapshot_ids: row.source_snapshot_ids || [] })).filter(row => row.count);
  const recap = input.recap_decision ? { decision_id: input.recap_decision.id, text: input.recap_decision.answer, status: 'draft', authorized_for_sending: false } : null;
  const sourceSnapshotIds = unique([
    ...input.matchups.flatMap(row => row.source_snapshot_ids || []),
    ...(input.evaluations || []).flatMap(row => row.source_snapshot_ids || row.evaluation?.source_snapshot_ids || []),
    ...(input.actions || []).flatMap(row => row.source_snapshot_ids || []),
    ...(input.lineup_days || []).flatMap(row => row.source_snapshot_ids || []),
    ...(input.recap_decision?.snapshot_ids || [])
  ]);
  const report = {
    schema_version: 1, kind: 'weekly_report', status: final ? 'final' : 'provisional',
    league_id: String(input.league_id), season: String(input.season), week: input.week,
    created_at: input.created_at || new Date().toISOString(), correction_of: input.correction_of || null,
    expected_matchups: expected, finalized_matchups: input.matchups.filter(row => row.status === 'final').length,
    source_snapshot_ids: sourceSnapshotIds, matchups: structuredClone(input.matchups),
    evaluation_ids: (input.evaluations || []).map(row => row.id).filter(Boolean), all_play: allPlay(input.matchups.filter(row => row.status === 'final')),
    lost_starts: { total: lostDays.reduce((sum, row) => sum + row.count, 0), days: lostDays },
    decision_review: { verified, unexecuted }, recap,
    caveats: final ? [] : [`Final post-mortem requires all ${expected === 5 ? 'five (5)' : expected} finalized matchups; ${input.matchups.filter(row => row.status === 'final').length} are final.`]
  };
  report.input_hash = canonicalDigest({ league_id: report.league_id, season: report.season, week: report.week, correction_of: report.correction_of, source_snapshot_ids: report.source_snapshot_ids, matchups: report.matchups, evaluation_ids: report.evaluation_ids });
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
