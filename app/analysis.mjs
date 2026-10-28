import { categoryKeys } from './schema.mjs';

export function categoryRanks(rows) {
  return rows.map(row => ({ ...row, ranks: Object.fromEntries(categoryKeys.map(key => {
    const value = row.stats?.[key];
    return [key, value == null ? null : 1 + rows.filter(other => other.stats?.[key] != null && other.stats[key] > value).length];
  })) }));
}
export function analyze(records) {
  const captures = records.filter(s => s.kind === 'league_capture').sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const current = captures.filter(s => s.status === 'complete').at(-1);
  const previous = captures.filter(s => s.status === 'complete').at(-2);
  const events = new Map();
  for (const capture of captures) for (const page of capture.pages.filter(p => p.kind === 'transactions')) {
    for (const row of page.rows) if (!events.has(row.id)) events.set(row.id, { ...row, first_observed_at: page.observed_at, source_snapshot_id: capture.id });
  }
  const availability = capture => new Map((capture?.pages || []).filter(p => p.kind === 'players').flatMap(p => p.rows.map(r => [r.id, r])));
  const now = availability(current), before = availability(previous);
  const movements = previous ? [
    ...[...now].filter(([id]) => !before.has(id)).map(([, row]) => ({ ...row, change: 'newly_available' })),
    ...[...before].filter(([id]) => !now.has(id)).map(([, row]) => ({ ...row, change: 'no_longer_listed_available' }))
  ] : [];
  const activity = new Map();
  for (const event of events.values()) for (const team of event.teams || []) {
    const key = team.href;
    if (!activity.has(key)) activity.set(key, { team: team.text, observed_events: 0, evidence: [] });
    const entry = activity.get(key); entry.observed_events++; entry.evidence.push(event.id);
  }
  const teamPage = current?.pages.find(p => p.kind === 'teamstats');
  const historical = records.find(s => s.kind === 'historical_import' && s.payload.kind === 'league_weekly_category_totals');
  const rankRows = teamPage?.rows || historical?.payload.teams.map(t => ({ ...t, stats: { ...t.stats, stl: t.stats.stl ?? t.stats.st } })) || [];
  return { snapshot_id: current?.id || historical?.id || null, historical: !teamPage, ranks: categoryRanks(rankRows), period: teamPage?.period || historical?.payload.coverage || null, movements, transactions: [...events.values()], manager_activity: [...activity.values()], notes: [
    'Ranks compare the displayed period, not future performance.',
    'Availability differences do not prove an add/drop; verify transaction history.',
    'Manager activity describes observed events only; preferences and intentions remain hypotheses.',
    previous ? `Availability compared with ${previous.id}` : 'Two complete captures are required for availability changes.'
  ] };
}
