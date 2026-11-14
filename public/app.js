const $ = id => document.getElementById(id);
let token = '', state = null, selected = null, poll = null;
let collector = null, pendingCollectorTime = null;
const node = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const display = value => value == null ? '—' : typeof value === 'number' && value > 0 && value < 1 ? value.toFixed(3) : String(value);
function table(headers, rows) {
  const wrap = node('div', null, 'scroll'), t = node('table'), head = node('thead'), hr = node('tr'), body = node('tbody');
  headers.forEach(h => hr.append(node('th', h))); head.append(hr);
  rows.forEach(row => { const tr = node('tr'); row.forEach(v => tr.append(node('td', display(v)))); body.append(tr); });
  t.append(head, body); wrap.append(t); return wrap;
}
function empty(target, text) { $(target).replaceChildren(node('p', text, 'empty')); }
async function api(path, payload) {
  const response = await fetch(`/api/${path}`, { method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Request failed'); return value;
}
async function attempt(action) { $('error').textContent = ''; try { await action(); } catch (error) { $('error').textContent = error.message; } }
const keys = ['fg_pct', 'ft_pct', 'three_pm', 'pts', 'oreb', 'reb', 'ast', 'stl', 'blk'];
const labels = ['FG%', 'FT%', '3PM', 'PTS', 'OREB', 'REB', 'AST', 'ST', 'BLK'];
async function selectSnapshot(id) {
  selected = id;
  const snapshot = await api(`snapshots/${encodeURIComponent(id)}`);
  if (selected !== id) return;
  document.querySelectorAll('.history-item').forEach(e => e.classList.toggle('selected', e.dataset.id === id));
  $('snapshot-title').textContent = snapshot.kind === 'historical_import' ? 'Historical evidence' : `${snapshot.status === 'complete' ? 'Complete' : 'Partial'} league capture`;
  const observed = state.snapshots.find(s => s.id === id)?.observed_at || snapshot.observed_at;
  $('snapshot-meta').textContent = `${snapshot.id} · ${observed || 'Original capture time unknown'} · ${snapshot.status}`;
  const content = $('snapshot-content'); content.replaceChildren();
  const payload = snapshot.payload;
  const invalid = state.snapshots.find(s => s.id === id)?.validation_error;
  if (invalid) { content.append(node('p', `${invalid}. Preserved as evidence; excluded from consolidated tables.`, 'caveat'), node('pre', JSON.stringify(payload, null, 2))); return; }
  if (payload) {
    const preserved = JSON.stringify(payload.kind === 'source_image' ? { ...payload, image_base64: '[image displayed above]' } : payload, null, 2);
    content.append(node('p', payload.coverage?.inference || 'Imported from an earlier source. This is not a fresh Yahoo refresh.'));
    if (payload.kind === 'source_image' && payload.mime_type === 'image/png' && /^[A-Za-z0-9+/=]+$/.test(payload.image_base64 || '')) { const img = document.createElement('img'); img.src = `data:image/png;base64,${payload.image_base64}`; img.alt = payload.original_path || 'Preserved source screenshot'; img.className = 'source-image'; content.append(img); }
    else if (payload.players?.some(p => p.stats)) content.append(table(['Player', 'GP', ...labels], payload.players.map(p => [p.name, p.stats.gp, ...keys.map(k => k === 'fg_pct' ? p.stats.fgm / p.stats.fga : k === 'ft_pct' ? p.stats.fta ? p.stats.ftm / p.stats.fta : null : p.stats[k])])));
    else if (payload.players) content.append(table(['Player', 'NBA team as observed', 'Eligibility'], payload.players.map(p => [p.name, p.nba_team_as_shown, p.eligible_positions_as_shown?.join(', ')])));
    else if (payload.teams) content.append(table(['Team', ...labels], payload.teams.map(t => [t.name, ...keys.map(k => k === 'stl' ? t.stats.stl ?? t.stats.st : t.stats[k])])));
    else if (payload.documents) { for (const doc of payload.documents) { const d = node('details'); d.append(node('summary', doc.title || doc.path), node('pre', doc.content)); content.append(d); } }
    else content.append(node('pre', preserved));
    const raw = node('details'); raw.append(node('summary', 'Preserved JSON / full provenance'), node('pre', preserved)); content.append(raw);
  } else for (const page of snapshot.pages) {
    const details = node('details'), summary = node('summary', `${page.kind}${page.team_id ? ` · team ${page.team_id}` : ''} · ${page.rows.length} rows`);
    details.append(summary, node('p', page.url, 'mono'), node('p', `Captured ${page.observed_at} · period: ${JSON.stringify(page.period)}`, 'mono'));
    if (page.rows.length) details.append(table(['Name / entry', ...labels], page.rows.map(r => [r.name || r.text, ...keys.map(k => r.stats?.[k])])));
    const raw = node('details'), rawSummary = node('summary', 'Inspect preserved page text'); raw.append(rawSummary, node('pre', page.raw.text)); details.append(raw); content.append(details);
  }
}
function showTab(id) {
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== id);
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
}
function renderState() {
  renderOverview(state.overview, id => attempt(async () => { if (state.decisions.some(d => d.id === id)) { showTab('decisions'); return; } showTab('evidence'); await selectSnapshot(id); }));
  renderIntelligence();
  $('league-id').textContent = state.league_id;
  const latest = state.snapshots.find(s => s.id === state.latest_id);
  $('freshness').textContent = latest ? `Latest complete capture: ${latest.observed_at}. Check its period before making a move.` : 'Saved observations consolidated below · no complete automated Yahoo capture yet.';
  $('signal').textContent = latest ? 'EVIDENCE CONNECTED' : 'SAVED EVIDENCE';
  $('notice').textContent = `${state.refresh.status.toUpperCase()} · ${state.refresh.detail}`;
  $('refresh').disabled = state.refresh.status === 'running';
  const history = $('history'); history.replaceChildren();
  for (const s of state.snapshots) {
    const b = node('button', s.status.toUpperCase(), 'history-item'); b.dataset.id = s.id;
    b.append(node('small', s.observed_at || 'Capture time unknown'), node('small', s.label));
    b.addEventListener('click', () => attempt(() => selectSnapshot(s.id))); history.append(b);
  }
  if (!state.snapshots.length) empty('history', 'No evidence yet. Import the historical records or refresh Yahoo after login.');
  const ranks = state.analysis.ranks;
  if (ranks.length) $('league-content').replaceChildren(node('p', state.analysis.historical ? 'HISTORICAL WEEK 1 · Unadjusted for games played; not a current strength forecast.' : `Captured period: ${JSON.stringify(state.analysis.period)}`), table(['Team', ...labels.map(l => `${l} rank`)], ranks.map(r => [r.name, ...keys.map(k => r.ranks[k])])));
  else empty('league-content', 'A complete capture with team statistics is needed to compare all teams.');
  const movements = state.analysis.movements;
  if (movements.length) $('movements').replaceChildren(table(['Player', 'Observed change'], movements.map(r => [r.name, r.change.replaceAll('_', ' ')])));
  else empty('movements', 'No verified availability changes. Two complete captures establish a comparison.');
  const activity = state.analysis.manager_activity;
  if (activity.length) $('activity').replaceChildren(table(['Team', 'Observed events'], activity.map(a => [a.team, a.observed_events])), node('p', 'Counts are observed history entries, not proof of strategy or intent.'));
  else empty('activity', 'No automated transaction capture yet. Imported activity is available in Overview.');
  const events = state.analysis.transactions;
  if (events.length) $('transactions').replaceChildren(table(['Entry', 'First observed', 'Status'], events.map(e => [e.text, e.first_observed_at, e.status])));
  else empty('transactions', 'No automated transaction capture yet. See Overview for imported transaction observations.');
  if (!$('task').options.length) state.tasks.forEach(t => $('task').append(new Option(t.replaceAll('_', ' '), t)));
  const choices = new Set([...$('evidence-select').selectedOptions].map(o => o.value));
  const eligibleSnapshots = state.snapshots.filter(s => s.kind !== 'source_image' && !s.validation_error);
  $('evidence-select').replaceChildren();
  eligibleSnapshots.forEach((s, i) => { const opt = new Option(`${s.status} · ${s.observed_at || s.label}`, s.id); opt.selected = choices.size ? choices.has(s.id) : i === 0; $('evidence-select').append(opt); });
  const oldPrevious = $('previous').value;
  $('previous').replaceChildren(new Option('None', ''));
  state.decisions.forEach(d => $('previous').append(new Option(`${d.task} · ${d.created_at}`, d.id)));
  $('previous').value = oldPrevious;
  $('model-state').textContent = state.model_configured ? 'Model configured. Each request saves a prompt fingerprint and its evidence references.' : 'Model not connected. Open Setup to save your model and API key.';
  $('ask').disabled = !state.model_configured || !state.prompt.ready || !eligibleSnapshots.length;
  const journal = $('journal'); journal.replaceChildren();
  for (const d of state.decisions) {
    const entry = node('div', null, 'journal'); entry.append(node('small', `${d.status.toUpperCase()} · ${d.created_at}`), node('h3', d.question), node('p', d.answer), node('p', `Prompt ${d.prompt_hash} · ${d.served_model}`, 'mono')); journal.append(entry);
  }
  if (!state.decisions.length) empty('journal', 'Your first decision brief will appear here, with its sources and prompt fingerprint.');
  $('prompt-hash').textContent = state.prompt.hash || state.prompt.error;
  $('prompt-text').textContent = state.prompt.text || '';
}
function evidenceLine(ids = []) { return ids.length ? ids.join(', ') : 'No linked source IDs'; }
function ageLine(value) { const age = Date.now() - Date.parse(value); return Number.isFinite(age) && age >= 0 ? `${(age / 3600000).toFixed(1)} hours old` : 'Age unknown'; }
function renderIntelligence() {
  const intel = state.intelligence || {}, target = $('matchup-intelligence'); target.replaceChildren();
  const forecast = state.forecast;
  const summary = node('div', null, 'metrics');
  const metric = (value, label) => { const box = node('div', null, 'metric'); box.append(node('strong', display(value)), node('span', label)); summary.append(box); };
  metric(forecast ? `Week ${forecast.week}` : '—', 'Latest frozen forecast');
  metric(forecast?.matchups?.length ?? 0, 'League matchups projected');
  metric(intel.optimization?.recommendation?.acquisitions_reserved ?? '—', 'Acquisitions reserved');
  metric(intel.evaluation_summary?.independent_validation_weeks ?? 0, 'Independent validation weeks');
  target.append(summary);
  if (forecast?.matchups?.length) {
    const card = node('article', null, 'panel'); card.append(node('h3', 'All matchup forecasts'), node('p', `Created ${forecast.created_at} · ${forecast.status}. Sources: ${evidenceLine(forecast.source_snapshot_ids || intel.forecasts?.[0]?.source_snapshot_ids || [])}`, 'mono'));
    card.append(table(['Matchup', 'Projected leader', 'Swingability', 'Swing categories'], forecast.matchups.map(row => [row.id, row.projected_leader || 'Unresolved', row.stability?.label || 'Unknown', Object.entries(row.category_outcomes || {}).filter(([, value]) => value === 'swing' || value === 'unknown').map(([key]) => key.toUpperCase()).join(', ') || 'None']))); target.append(card);
  } else target.append(node('p', 'No frozen league forecast yet.', 'empty'));
  if (intel.optimization) {
    const optimization = node('article', null, 'panel'), rec = intel.optimization.recommendation;
    optimization.append(node('h3', 'Optionality plan'), node('p', `${rec.kind.replaceAll('_', ' ')} · score ${rec.score} · uses ${rec.acquisitions_used}, reserves ${rec.acquisitions_reserved} · claim risk ${rec.comparison?.claim_risk ?? '—'}.`), node('p', `Status: ${intel.optimization.execution_status}. Sources: ${evidenceLine(intel.optimization.source_snapshot_ids)}`, 'mono'));
    if (intel.optimization.fallbacks?.length) optimization.append(table(['Alternative', 'Moves', 'Score'], intel.optimization.fallbacks.map(row => [row.id, row.opportunity_ids.join(', ') || 'Hold', row.score])));
    if (intel.optimization.next_reconsideration) optimization.append(node('p', `${intel.optimization.next_reconsideration.at || 'On evidence change'} · ${intel.optimization.next_reconsideration.reason}`, 'caveat'));
    target.append(optimization);
  }
  if (intel.evaluation) {
    const evaluation = node('article', null, 'panel'); evaluation.append(node('h3', `${intel.evaluation.status.toUpperCase()} forecast evaluation`), node('p', `Correlation: ${intel.evaluation.correlation_key}. ${intel.evaluation_summary.origins} forecast origin(s) across ${intel.evaluation_summary.independent_validation_weeks} independent finalized week(s).`), node('p', `Sources: ${evidenceLine(intel.evaluation.source_snapshot_ids)}`, 'mono')); target.append(evaluation);
  }
  if (intel.report) {
    const report = node('article', null, 'panel'); report.append(node('h3', `Week ${intel.report.week} ${intel.report.status} review`), node('p', `${intel.report.finalized_matchups}/${intel.report.expected_matchups} matchups final · ${intel.report.lost_starts.total} lost usable starts · ${intel.report.decision_review.verified.length} verified decision action(s).`), node('p', `Sources: ${evidenceLine(intel.report.source_snapshot_ids)}`, 'mono'));
    if (intel.report.caveats?.length) report.append(node('p', intel.report.caveats.join(' '), 'caveat'));
    if (intel.report.recap) report.append(node('p', 'League recap is a draft and has not been authorized for sending.', 'caveat'));
    target.append(report);
  }
  const operations = $('operations-intelligence'); operations.replaceChildren();
  const latest = state.snapshots.find(row => row.id === state.latest_id);
  operations.append(table(['Control', 'State', 'Evidence'], [
    ['Yahoo refresh', state.refresh.status, state.refresh.detail],
    ['Latest complete capture', latest?.observed_at ? ageLine(latest.observed_at) : 'None', latest ? `${latest.observed_at} · ${latest.id}` : 'No complete pointer'],
    ['Master prompt', state.prompt.ready ? 'Ready' : 'Blocked', state.prompt.hash || state.prompt.error],
    ['Decision model', state.model_configured ? 'Configured' : 'Not configured', 'Recommendations remain advice only'],
    ['Model call budget', `${state.operations?.model_usage?.remaining ?? '—'} remaining`, `${state.operations?.model_usage?.attempted ?? 0}/${state.operations?.model_usage?.limit ?? '—'} reserved or attempted · ${state.operations?.model_usage?.actual?.total_tokens ?? 0} reported tokens`],
    ['Private volume', `${state.operations?.storage?.files ?? 0} files`, `${state.operations?.storage?.bytes ?? 0} bytes${state.operations?.storage?.quota_used_percent == null ? ' · quota not configured' : ` · ${state.operations.storage.quota_used_percent}% of configured quota`}`],
    ['Action executor', state.actions?.mode || 'shadow', state.actions?.gates_verified ? `Enabled classes: ${state.actions.enabled_classes.join(', ') || 'none'}` : 'External pilot gates are unverified'],
    ['Stop switch', state.actions?.control?.stop_switch ? 'ACTIVE' : 'Released', state.actions?.control?.human_takeover ? 'Human takeover is active' : 'No human takeover recorded'],
    ['Live roster mutations', state.actions?.mode === 'live' && state.actions?.gates_verified ? 'Class bounded' : 'Disabled', 'Each live action still requires a dedicated one-time manager authorization']
  ]));
  if (state.actions?.intents?.length) operations.append(node('h3', 'Action intents'), table(['Class', 'Mode', 'Scoring date', 'Expires'], state.actions.intents.slice(0, 10).map(row => [row.action_class, row.execution_mode, row.scoring_date, row.expires_at])));
  if (state.overview?.gaps?.length) operations.append(node('h3', 'Coverage gaps'), ...state.overview.gaps.map(gap => node('p', gap, 'caveat')));
}
async function load() {
  state = await api('state'); renderState();
  if (!selected && state.snapshots.length) await selectSnapshot(state.latest_id || state.snapshots[0].id);
  clearTimeout(poll);
  if (state.refresh.status === 'running') poll = setTimeout(() => attempt(load), 2000);
}
async function loadOperations() {
  state.operations = { ...(state.operations || {}), ...await api('operations') };
  renderIntelligence();
}
$('login-form').addEventListener('submit', e => { e.preventDefault(); attempt(async () => { token = $('token').value.trim(); await load(); await Promise.all([loadSetup(), loadOperations()]); $('token').value = ''; $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = false; }); });
$('logout').addEventListener('click', () => { token = ''; location.reload(); });
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => { showTab(button.dataset.tab); if (button.dataset.tab === 'setup') void attempt(loadOperations); }));
$('refresh').addEventListener('click', () => attempt(async () => { await api('refresh', {}); await load(); }));
async function loadSetup() {
  const settings = await api('setup');
  $('setup-league').value = settings.league_id;
  $('setup-teams').value = settings.expected_teams;
  $('setup-model').value = settings.model;
  $('setup-endpoint').value = settings.endpoint;
  $('key-status').textContent = settings.api_key_saved ? 'API key saved privately. Leave blank to keep it.' : 'No API key saved yet.';
  $('yahoo-status').textContent = settings.remote_browser_saved ? 'Remote browser configured. Refresh Yahoo to verify access.' : settings.yahoo_session_saved ? 'Yahoo session saved. Refresh Yahoo to verify access.' : 'Yahoo is not connected yet.';
  await loadCollector();
}
async function loadCollector() {
  collector = await api('collector');
  $('collector-status').textContent = `${collector.paused ? 'PAUSED' : 'ACTIVE'} · 06:00 / 18:00 Singapore · next slot ${collector.next_run} · ${collector.gates_verified ? 'Pilot gates attested by operator' : 'Live pilot gates unverified'}`;
  if (collector.scope) {
    $('collector-team').value = collector.scope.team_id;
    $('collector-season').value = collector.scope.season;
    $('collector-week').value = collector.scope.scoring_period.key;
    $('collector-timezone').value = collector.scope.scoring_period.timezone;
  }
  $('collector-run').disabled = !collector.scope;
  $('collector-run').textContent = collector.gates_verified && collector.trigger_configured ? 'Run now' : 'Prepare supervised run';
  $('collector-pause').disabled = !collector.scope || (!collector.gates_verified && collector.paused);
  $('collector-pause').textContent = collector.paused ? 'Resume schedule' : 'Pause schedule';
  $('collector-attempts').replaceChildren(table(['Attempt', 'Outcome', 'Finished'], collector.attempts.map(a => [a.id, a.outcome, a.finished_at])));
}
$('collector-run').addEventListener('click', () => attempt(async () => {
  $('collector-run').disabled = true;
  pendingCollectorTime ||= new Date().toISOString();
  try {
    const result = await api('collector/run', { intended_for: pendingCollectorTime, dispatch: collector.gates_verified && collector.trigger_configured });
    if (['awaiting_artifacts', 'supervised_upload'].includes(result.launch.status)) pendingCollectorTime = null;
    $('collector-result').textContent = `${result.run.id} · ${result.launch.status || result.launch.outcome}. ${result.launch.status === 'supervised_upload' ? 'Run prepared for a supervised upload; nothing started in boxes.dev.' : result.launch.status === 'reconciliation_required' ? 'The dispatch result is ambiguous; reconcile it before retrying so the collector cannot launch twice.' : result.launch.outcome === 'failed' ? 'Launch failed; retry will preserve this logical run.' : 'Launch acceptance is not evidence of completed capture.'}`;
  } finally { await loadCollector(); }
}));
$('collector-pause').addEventListener('click', () => attempt(async () => { await api('collector/settings', { paused: !collector.paused }); await loadCollector(); }));
function setupForm(id, action) {
  $(id).addEventListener('submit', e => { e.preventDefault(); attempt(async () => {
    const button = $(id).querySelector('button'); button.disabled = true;
    $('setup-status').textContent = 'Saving…';
    try { await action(); await loadSetup(); await load(); $('setup-status').textContent = 'Saved to your private volume.'; }
    catch (error) { $('setup-status').textContent = 'Not saved. See the message below.'; throw error; }
    finally { button.disabled = false; }
  }); });
}
setupForm('league-form', () => api('setup', { leagueId: $('setup-league').value.trim(), expectedTeams: Number($('setup-teams').value) }));
setupForm('collector-form', () => api('collector/settings', { paused: true, scope: { dataset: 'team_roster', league_id: state.league_id, season: $('collector-season').value.trim(), team_id: $('collector-team').value.trim(), scoring_period: { kind: 'week', key: $('collector-week').value.trim(), timezone: $('collector-timezone').value.trim() }, value_basis: { value: 'observed', aggregation: 'roster' } } }));
setupForm('model-form', async () => {
  const patch = { model: $('setup-model').value.trim(), endpoint: $('setup-endpoint').value.trim() };
  if ($('setup-key').value.trim()) patch.apiKey = $('setup-key').value.trim();
  await api('setup', patch); $('setup-key').value = '';
});
setupForm('browser-form', async () => { await api('setup', { cdpUrl: $('setup-browser').value.trim() }); $('setup-browser').value = ''; });
async function uploadJSON(input, route) {
  const file = $(input).files[0];
  const maxSize = route === 'import' ? 1048576 : 512000;
  if (!file || file.size > maxSize) throw new Error(`Choose a JSON file smaller than ${Math.floor(maxSize / 1024)} KB`);
  let data; try { data = JSON.parse(await file.text()); } catch { throw new Error('The file is not valid JSON'); }
  await api(route, data); $(input).value = '';
}
setupForm('yahoo-form', () => uploadJSON('yahoo-file', 'setup/yahoo'));
setupForm('import-form', () => uploadJSON('import-file', 'import'));
$('decision-form').addEventListener('submit', e => { e.preventDefault(); attempt(async () => { $('ask').disabled = true; try { await api('decisions', { task: $('task').value, question: $('question').value, snapshot_ids: [...$('evidence-select').selectedOptions].map(o => o.value), ...($('task').value === 'followup' ? { previous_id: $('previous').value } : {}) }); await load(); } finally { $('ask').disabled = !state.model_configured || !state.prompt.ready; } }); });
