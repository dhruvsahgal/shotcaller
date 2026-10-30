function renderOverview(data, openEvidence) {
  const root = document.getElementById('overview-content');
  root.replaceChildren();
  if (!data) { root.append(node('p', 'No consolidated evidence yet. Import your saved records in Setup.')); return; }
  const provenance = meta => {
    const row = node('div', null, 'provenance');
    if (!meta) return row;
    row.append(node('span', `Observed: ${meta.observed_at || 'unknown — historical source'} · ${meta.status || 'saved'}`));
    const button = node('button', 'Source ↗', 'source-link');
    button.addEventListener('click', () => openEvidence(meta.id)); row.append(button);
    return row;
  };
  const panel = (id, title, detail, meta) => {
    const el = node('article', null, 'panel'); el.id = `overview-${id}`;
    el.append(node('h2', title)); if (detail) el.append(node('p', detail));
    if (meta) el.append(provenance(meta)); root.append(el); return el;
  };
  const statsTable = players => table(['Player', 'GP', ...labels], players.map(p => {
    const s = p.stats || p;
    return [p.name, s.gp, ...keys.map(k => {
      if (k === 'fg_pct' && s.fgm != null && s.fga != null) return s.fga > 0 ? s.fgm / s.fga : null;
      if (k === 'ft_pct' && s.ftm != null && s.fta != null) return s.fta > 0 ? s.ftm / s.fta : null;
      return k === 'stl' ? s.stl ?? s.st : s[k];
    })];
  }));
  const m = data.matchup, own = m?.teams?.[0], opponent = m?.teams?.[1];
  const top = node('div', null, 'overview-intro');
  top.append(node('div', 'YOUR SAVED LEAGUE / ONE VIEW', 'eyebrow'), node('h2', 'The whole board.'), node('p', 'Each section keeps its own observation date. These are saved results and notes; they do not update until new evidence is imported or captured.'));
  root.append(top);
  const metrics = node('div', null, 'metrics');
  const metric = (value, label) => { const box = node('div', null, 'metric'); box.append(node('strong', value), node('span', label)); metrics.append(box); };
  metric(own && opponent ? `${own.categories_won ?? '—'}–${opponent.categories_won ?? '—'}` : '—', m ? `Week ${m.week} · observed score` : 'Matchup not captured');
  metric(own ? `${own.games_remaining_displayed ?? '—'} / ${opponent?.games_remaining_displayed ?? '—'}` : '—', 'Remaining games · you / opponent');
  metric(data.status ? `${data.status.adds_used ?? '—'} / ${data.status.adds_allowed ?? '—'}` : '—', 'Weekly adds used · at last check');
  metric(String(data.sources.length), 'Preserved evidence records');
  root.append(metrics);
  const jump = node('div', null, 'jump-links');
  for (const [id, label] of [['matchup','Matchup'],['roster','Roster'],['lineups','Lineups'],['market','Waivers'],['transactions','Transactions'],['league','League'],['journal','Decisions'],['archive','Notebook']]) {
    const a = node('a', label); a.href = `#overview-${id}`; jump.append(a);
  }
  root.append(jump);
  const matchup = panel('matchup', own && opponent ? `${own.name} vs ${opponent.name}` : 'Matchup', m ? `Week ${m.week} · provisional totals. Margins compare the same category; percentages use makes and attempts where available.` : 'No dated matchup observation saved.', m?.meta);
  if (own && opponent) {
    matchup.append(table(['Category', own.name, opponent.name, 'Margin'], keys.map((k,i) => {
      const a = own.stats[k], b = opponent.stats[k], delta = a != null && b != null ? a - b : null;
      const margin = delta == null ? '—' : `${delta > 0 ? '+' : ''}${k.endsWith('_pct') ? (delta * 100).toFixed(2) + ' pp' : delta}`;
      return [labels[i], a, b, margin];
    })));
  }
  if (data.matchup_history.length > 1) {
    const history = node('details'); history.append(node('summary', 'Matchup trend / dated observations'));
    history.append(table(['Observed', 'Week', 'Score', '3PM margin', 'REB margin', 'AST margin', 'ST margin'], data.matchup_history.map(h => {
      const [a,b] = h.teams;
      return [h.meta.observed_at, h.week, `${a?.categories_won ?? '—'}–${b?.categories_won ?? '—'}`, ...['three_pm','reb','ast','stl'].map(k=>a?.stats[k] != null && b?.stats[k] != null ? a.stats[k]-b.stats[k] : null)];
    })));
    matchup.append(history);
  }
  if (m?.meta.coverage?.data_quality) matchup.append(node('p', m.meta.coverage.data_quality, 'caveat'));
  const roster = panel('roster', 'Your roster', 'Membership and eligibility are dated observations. Historical Team Log statistics below do not establish current ownership.', data.roster?.meta);
  if (data.roster?.meta.coverage?.warning) roster.append(node('p',data.roster.meta.coverage.warning,'caveat'));
  if (data.roster) roster.append(table(['Player', 'NBA team shown', 'Eligible positions shown'], data.roster.players.map(p=>[p.name,p.nba_team_as_shown,(p.eligible_positions_as_shown || []).join(', ')])));
  else roster.append(node('p','Current roster membership has not been verified in a structured record.'));
  if (data.team_log) {
    const detail = node('details'); detail.append(node('summary', 'Historical cumulative player statistics'), provenance(data.team_log.meta), node('p', 'Coverage filter was not confirmed. Do not combine with weekly totals or difference into daily stats.'), statsTable(data.team_log.players)); roster.append(detail);
  }
  const lineups = panel('lineups', 'Lineup audit', 'Yahoo scoring dates. Saved slots and schedules can change; this is not a live injury or lineup check.', data.lineups?.meta);
  if (data.lineups) lineups.append(table(['Scoring date', 'Playing in active slots', 'Benched with game', 'Conflict', 'Observed'], data.lineups.days.map(d=>[d.date,Array.isArray(d.playing_in_active_slots) ? d.playing_in_active_slots.join(', ') || 'None observed' : 'Not captured',Array.isArray(d.benched_with_game) ? d.benched_with_game.join(', ') || 'None observed' : 'Not captured',d.conflict === true ? 'Yes' : d.conflict === false ? 'None observed' : 'Not captured', d.meta?.observed_at])));
  else lineups.append(node('p','No lineup audit saved.'));
  const market = panel('market', 'Waiver watch', data.waivers?.meta.coverage?.waiver_scope || 'Latest saved subset, not the entire waiver wire. Season averages are not forecasts; availability needs rechecking before an add.', data.waivers?.meta);
  if (data.waivers) market.append(statsTable(data.waivers.players)); else market.append(node('p','No waiver observations saved.'));
  const transactions = panel('transactions', 'League activity', 'Observed transaction rows. Displayed times retain Yahoo’s original text; missing drops are not proof that no player was dropped.');
  if (data.transactions.length) {
    transactions.append(table(['Yahoo displayed time', 'Team', 'Added', 'Dropped', 'Observed'], data.transactions.map(t=>[t.displayed_at,t.team,t.add,t.drop,t.meta?.observed_at])));
    transactions.append(provenance(data.transactions[0].meta));
  } else transactions.append(node('p','No transaction observations saved.'));
  const league = panel('league', 'League comparison', data.league ? `Week ${data.league.week ?? 'unknown'} historical totals. Games played are not normalized; this is not a current strength forecast.` : 'No league-wide baseline saved.', data.league?.meta);
  if (data.league) league.append(table(['Team',...labels], data.league.teams.map(t=>[t.name,...keys.map(k=>t.stats[k])])));
  const journal = panel('journal', 'Decisions & recorded actions', 'Dated advice stays separate from confirmed actions. This view does not generate a new recommendation.');
  if (data.recommendation) {
    journal.append(node('h3','Last saved recommendation'), provenance(data.recommendation.meta), node('p',data.recommendation.reason));
    if (data.recommendation.conditional_stream_slot) journal.append(node('p',data.recommendation.conditional_stream_slot));
    if (data.recommendation.caveat) journal.append(node('p',data.recommendation.caveat,'caveat'));
  }
  for (const d of data.journal) { const entry = node('div',null,'journal'); entry.append(node('small', `${d.status || 'advice'} · ${d.decided_on || d.created_at || 'date unknown'}`),node('p',d.summary || d.question || d.task),node('p',d.answer || ''),provenance(d.meta)); journal.append(entry); }
  if (!data.recommendation && !data.journal.length) journal.append(node('p','No recorded decisions.'));
  const archive = panel('archive','Notebook & research','All imported reports, knowledge notes and research, preserved as written. Older notes may describe setup or scores that have since changed; use their dates and the latest section above.');
  for (const doc of data.documents) {
    const details = node('details'); details.append(node('summary',doc.title || doc.path),node('small',doc.path),provenance(doc.meta),node('pre',doc.content)); archive.append(details);
  }
  if (!data.documents.length) archive.append(node('p','No notebook documents imported yet.'));
  const coverage = panel('coverage','Coverage & storage','Numbers live in immutable JSON snapshots on the Railway volume. Notes live alongside them. SQLite is the next storage option; it does not need another service.');
  const list = node('ul'); data.gaps.forEach(g=>list.append(node('li',g))); coverage.append(list);
  const sources = node('details'); sources.append(node('summary',`All ${data.sources.length} evidence records`));
  for (const s of data.sources) { const row = node('div',null,'source-row'); row.append(node('strong',s.label),provenance(s)); sources.append(row); }
  coverage.append(sources);
}
