const countStats = ['gp', 'fgm', 'fga', 'ftm', 'fta', 'three_pm', 'pts', 'oreb', 'reb', 'ast', 'stl', 'blk'];

function clean(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function playerMetadata(row) {
  const raw = String(row.fields?.Players ?? row.fields?.Player ?? '');
  const lines = raw.split('\n').map(clean).filter(Boolean);
  const teamLine = lines.find(line => /^[A-Z]{2,3}\s+-\s+/.test(line)) ?? '';
  const match = teamLine.match(/^([A-Z]{2,3})\s+-\s+(.+)$/);
  return {
    nba_team: match?.[1] ?? null,
    eligibility: match?.[2]?.split(',').map(clean).filter(Boolean) ?? [],
    injury: lines.find(line => /^(?:IL\+?|O|Q|DTD|GTD|SUSP|NA)$/i.test(line)) ?? null
  };
}

function slotGroup(slot) {
  if (/^BN$/i.test(slot)) return 'bench';
  if (/^(?:IL|IL\+)$/i.test(slot)) return 'il';
  return 'active';
}

function stats(row, zeroMissing = false) {
  const source = row.stats ?? {};
  return Object.fromEntries(countStats.filter(key => Object.hasOwn(source, key)).map(key => [key, zeroMissing && source[key] == null ? 0 : source[key]]));
}

export function normalizeRosterRows(parsed, teamId) {
  return parsed.rows.filter(row => row.id).map(row => {
    const slot = clean(row.fields?.Pos ?? row.fields?.Position ?? '');
    return { player_id: row.id, team_id: teamId, name: clean(row.name), slot, slot_group: slotGroup(slot), ...playerMetadata(row) };
  });
}

export function normalizePlayerPeriodRows(parsed, teamId) {
  return parsed.rows.filter(row => row.id).map(row => ({ player_id: row.id, team_id: teamId, name: clean(row.name), stats: stats(row) }));
}

export function normalizeDailyLineupRows(parsed, teamId) {
  return normalizeRosterRows(parsed, teamId).map(({ player_id, name, slot, slot_group }) => ({ player_id, team_id: teamId, name, slot, slot_group }));
}

export function normalizeDailyContributionRows(parsed, teamId) {
  const byId = new Map(parsed.rows.filter(row => row.id).map(row => [row.id, row]));
  return normalizeRosterRows(parsed, teamId).filter(row => row.slot_group === 'active').map(row => ({
    player_id: row.player_id,
    team_id: teamId,
    name: row.name,
    fantasy_counted: true,
    stats: stats(byId.get(row.player_id), true)
  }));
}

export function normalizeMatchupRows(parsed, expectedTeamIds) {
  const expected = new Set(expectedTeamIds);
  return parsed.rows.filter(row => expected.has(row.id)).map(row => ({ team_id: row.id, name: clean(row.name), stats: stats(row) }));
}

export function normalizeTeamPeriodRows(parsed, expectedTeamIds) {
  const expected = new Set(expectedTeamIds);
  return parsed.rows.filter(row => expected.has(row.id)).map(row => ({ team_id: row.id, name: clean(row.name), stats: stats(row) }));
}

export function normalizeMarketRows(parsed, availability) {
  return parsed.rows.filter(row => row.id).map(row => ({ player_id: row.id, name: clean(row.name), availability, stats: stats(row) }));
}

export function normalizeTransactionRows(parsed) {
  return parsed.rows.map(row => ({
    provider_event_id: row.id,
    status: row.status,
    legs: row.players.map(player => ({
      player_id: new URL(player.href).pathname.match(/\/nba\/players\/(\d+)/)?.[1] ?? null,
      player_name: clean(player.text)
    })).filter(leg => leg.player_id),
    text: row.text
  }));
}
