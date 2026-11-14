const inactiveSlots = new Set(['BN', 'IL', 'IL+', 'NA']);

export function scoringDate(instant, timezone) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid game start time');
  if (typeof timezone !== 'string' || !timezone.trim()) throw new Error('Invalid scoring timezone');
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    throw new Error('Invalid scoring timezone');
  }
}

function normalizedPositionFits(eligible, target) {
  if (target === 'UTIL') return eligible.size > 0;
  if (target === 'G') return eligible.has('PG') || eligible.has('SG') || eligible.has('G');
  if (target === 'F') return eligible.has('SF') || eligible.has('PF') || eligible.has('F');
  return eligible.has(target);
}

export function positionFits(positions, slot) {
  return normalizedPositionFits(new Set((positions || []).map(position => String(position).toUpperCase())), String(slot).toUpperCase());
}

function addEdge(graph, from, to, capacity, cost, meta = null) {
  const forward = { to, reverse: graph[to].length, capacity, cost, meta };
  const reverse = { to: from, reverse: graph[from].length, capacity: 0, cost: -cost, meta: null };
  graph[from].push(forward); graph[to].push(reverse);
}

function maximumWeightAssignments(players, slots, eligibility) {
  const source = 0, playerOffset = 1, slotOffset = playerOffset + players.length, sink = slotOffset + slots.length;
  const graph = Array.from({ length: sink + 1 }, () => []);
  players.forEach((player, playerIndex) => {
    addEdge(graph, source, playerOffset + playerIndex, 1, 0);
    slots.forEach((slot, slotIndex) => {
      if (!normalizedPositionFits(eligibility.get(player.id), slot.target)) return;
      const value = Number.isFinite(player.value) ? player.value : 0;
      addEdge(graph, playerOffset + playerIndex, slotOffset + slotIndex, 1, -(value * 1000 + 1), { player, slot });
    });
  });
  slots.forEach((_, slotIndex) => addEdge(graph, slotOffset + slotIndex, sink, 1, 0));
  while (true) {
    const distance = Array(graph.length).fill(Infinity), previous = Array(graph.length).fill(null);
    distance[source] = 0;
    for (let iteration = 0; iteration < graph.length - 1; iteration++) {
      let changed = false;
      for (let from = 0; from < graph.length; from++) {
        if (!Number.isFinite(distance[from])) continue;
        graph[from].forEach((edge, edgeIndex) => {
          if (edge.capacity <= 0 || distance[from] + edge.cost >= distance[edge.to]) return;
          distance[edge.to] = distance[from] + edge.cost;
          previous[edge.to] = { from, edgeIndex };
          changed = true;
        });
      }
      if (!changed) break;
    }
    if (!previous[sink] || distance[sink] >= 0) break;
    for (let node = sink; node !== source;) {
      const { from, edgeIndex } = previous[node], edge = graph[from][edgeIndex];
      edge.capacity -= 1; graph[node][edge.reverse].capacity += 1; node = from;
    }
  }
  const rows = [];
  for (let playerIndex = 0; playerIndex < players.length; playerIndex++) {
    for (const edge of graph[playerOffset + playerIndex]) {
      if (edge.meta && edge.capacity === 0) rows.push({ player_id: edge.meta.player.id, slot: edge.meta.slot.slot, slot_index: edge.meta.slot.index, locked: false });
    }
  }
  return rows;
}

export function assignLineup(players, rosterSlots) {
  if (new Set(players.map(player => player.id)).size !== players.length) throw new Error('Duplicate player in daily lineup candidates');
  const slots = rosterSlots.map((slot, index) => ({ slot, target: String(slot).toUpperCase(), index })).filter(row => !inactiveSlots.has(row.target));
  const eligibility = new Map(players.map(player => [player.id, new Set((player.eligible_positions || []).map(position => String(position).toUpperCase()))]));
  const assigned = [], usedPlayers = new Set(), usedSlots = new Set(), lockedInactivePlayerIds = new Set();
  for (const player of players) {
    if (!player.locked_slot) continue;
    const locked = String(player.locked_slot).toUpperCase();
    if (inactiveSlots.has(locked)) { lockedInactivePlayerIds.add(player.id); continue; }
    const target = slots.find(row => !usedSlots.has(row.index) && row.target === locked && normalizedPositionFits(eligibility.get(player.id), row.target));
    if (!target) throw new Error(`Locked player ${player.id} has no legal ${player.locked_slot} slot`);
    assigned.push({ player_id: player.id, slot: target.slot, slot_index: target.index, locked: true });
    usedPlayers.add(player.id); usedSlots.add(target.index);
  }
  const open = slots.filter(row => !usedSlots.has(row.index));
  const available = players.filter(player => !usedPlayers.has(player.id) && !lockedInactivePlayerIds.has(player.id));
  const assignments = [...assigned, ...maximumWeightAssignments(available, open, eligibility)].sort((a, b) => a.slot_index - b.slot_index);
  const starting = new Set(assignments.map(row => row.player_id));
  const bench = players.filter(player => !starting.has(player.id)).map(player => ({ player_id: player.id, locked: lockedInactivePlayerIds.has(player.id) }));
  return { assignments, bench, open_slots: slots.length - assignments.length };
}
