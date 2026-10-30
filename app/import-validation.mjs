const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function rowError(row, depth = 0) {
  if (!object(row) || depth > 8) return 'Invalid nested player row';
  for (const field of ['stats', 'shooting']) if (row[field] != null && !object(row[field])) return `Invalid ${field}: expected an object`;
  if (row.eligible_positions_as_shown != null && (!Array.isArray(row.eligible_positions_as_shown) || row.eligible_positions_as_shown.some(p => typeof p !== 'string'))) return 'Invalid player eligibility';
  if (row.players != null) {
    if (!Array.isArray(row.players)) return 'Invalid nested players';
    for (const player of row.players) { const error = rowError(player, depth + 1); if (error) return error; }
  }
  return null;
}

// Older archives remain readable even if they predate import validation.
export function historicalShapeError(payload) {
  if (!object(payload)) return 'Invalid historical payload';
  for (const field of ['coverage', 'roster_status', 'recommendation', 'reported_totals']) {
    if (payload[field] != null && !object(payload[field])) return `Invalid ${field}: expected an object`;
  }
  const arrays = ['players', 'teams', 'days', 'remaining_lineups', 'waiver_candidates_season_averages', 'recent_transactions', 'documents', 'journal'];
  for (const field of arrays) {
    if (payload[field] == null) continue;
    if (!Array.isArray(payload[field]) || payload[field].some(row => !object(row))) return `Invalid ${field}: expected an array of objects`;
  }
  const rows = [...(payload.players ?? []), ...(payload.teams ?? []), ...(payload.waiver_candidates_season_averages ?? [])];
  for (const row of rows) { const error = rowError(row); if (error) return error; }
  for (const day of [...(payload.days ?? []), ...(payload.remaining_lineups ?? [])]) {
    for (const field of ['playing_in_active_slots', 'benched_with_game']) {
      if (day[field] != null && (!Array.isArray(day[field]) || day[field].some(p => typeof p !== 'string'))) return `Invalid lineup ${field}`;
    }
    if (day.conflict != null && typeof day.conflict !== 'boolean') return 'Invalid lineup conflict';
  }
  for (const doc of payload.documents ?? []) if (typeof doc.path !== 'string' || typeof doc.content !== 'string') return 'Invalid document: path and content are required';
  return null;
}
