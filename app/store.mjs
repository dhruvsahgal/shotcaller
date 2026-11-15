import { mkdir, readFile, readdir, rename, writeFile, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { historicalShapeError } from './import-validation.mjs';
import { validateIdentifier } from './schema.mjs';
import { compareObservations, observationEnvelope, observationScopeKey } from './observations.mjs';
import { attemptEnvelope, runEnvelope } from './runs.mjs';
import { canonical } from './value.mjs';

const boundedHistoryFolders = new Set(['forecasts', 'optimizations', 'evaluations', 'reports', 'action-intents', 'action-authorizations', 'action-attempts', 'action-outcomes', 'action-reconciliations']);

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const canonicalDigest = value => digest(canonical(value));
export function safeId(id) {
  return validateIdentifier(id);
}
export async function atomicJSON(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const h = await open(temp, 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(value, null, 2)); await h.sync(); }
  finally { await h.close(); }
  try { await rename(temp, file); } finally { await rm(temp, { force: true }); }
}
export class Store {
  constructor(root) {
    this.root = root;
    this.initializing = null;
    this.observationIndexUpdating = Promise.resolve();
    this.reportIndexUpdating = Promise.resolve();
    this.historyIndexUpdating = new Map();
  }
  async init() {
    if (!this.initializing) {
      this.initializing = Promise.all(['snapshots', 'decisions', 'forecasts', 'optimizations', 'evaluations', 'reports', 'action-intents', 'action-authorizations', 'action-attempts', 'action-outcomes', 'action-reconciliations', 'action-evidence', 'runs', 'attempts', 'observations', 'indexes'].map(d => mkdir(join(this.root, d), { recursive: true, mode: 0o700 }))).catch(error => { this.initializing = null; throw error; });
    }
    await this.initializing;
  }
  async publish(record, folder = 'snapshots', markdown) {
    await this.init();
    safeId(record.id);
    const parent = join(this.root, folder), target = join(parent, record.id);
    const temp = join(parent, `.pending-${randomUUID()}`);
    await mkdir(temp, { mode: 0o700 });
    try {
      await atomicJSON(join(temp, 'snapshot.json'), record);
      if (markdown) await writeFile(join(temp, 'brief.md'), markdown, { mode: 0o600 });
      await rename(temp, target);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      const previous = JSON.parse(await readFile(join(target, 'snapshot.json'), 'utf8'));
      if (previous.content_hash !== record.content_hash) throw new Error('Immutable record conflict');
      return previous;
    } finally { await rm(temp, { recursive: true, force: true }); }
    if (boundedHistoryFolders.has(folder)) await this.updateHistoryIndex(folder, record);
    return record;
  }
  async saveCapture(capture) {
    if (!['complete', 'partial'].includes(capture.status) || !Array.isArray(capture.pages) || !Number.isFinite(Date.parse(capture.observed_at))) throw new Error('Invalid capture');
    const record = { ...capture, schema_version: 2, kind: 'league_capture', id: `capture-${randomUUID()}`, stored_at: new Date().toISOString(), content_hash: digest(capture) };
    await this.publish(record);
    if (record.status === 'complete') await atomicJSON(join(this.root, 'latest.json'), { id: record.id });
    return record;
  }
  async importHistorical(payload) {
    if (!payload || typeof payload !== 'object' || !payload.snapshot_id || !payload.source) throw new Error('Expected a sourced historical snapshot');
    const invalid = historicalShapeError(payload);
    if (invalid) throw new Error(invalid);
    const hash = digest(payload);
    return this.publish({ schema_version: 2, id: `import-${hash.slice(0, 24)}`, kind: 'historical_import', status: 'historical', stored_at: new Date().toISOString(), content_hash: hash, payload });
  }
  async saveRun(input) {
    const contentHash = canonicalDigest(input);
    return this.publish(runEnvelope(input, new Date().toISOString(), contentHash), 'runs');
  }
  async saveRunAttempt(input) {
    try { await this.read(input?.run_id, 'runs'); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('Run attempt references an unknown run'); throw error; }
    const contentHash = canonicalDigest(input);
    return this.publish(attemptEnvelope(input, new Date().toISOString(), contentHash), 'attempts');
  }
  async observationRecord(input) {
    if (input?.correction_of != null) {
      try { await this.read(input.correction_of, 'observations'); }
      catch (error) { if (error.code === 'ENOENT') throw new Error('Observation correction references an unknown record'); throw error; }
    }
    const contentHash = canonicalDigest(input);
    return observationEnvelope(input, new Date().toISOString(), contentHash);
  }
  async saveObservation(input) {
    const record = await this.publish(await this.observationRecord(input), 'observations');
    await this.updateCompleteObservationIndex(record);
    return record;
  }
  async saveObservations(inputs, concurrency = 8, updateIndex = true) {
    if (!Array.isArray(inputs) || !inputs.length || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid observation batch');
    const records = await Promise.all(inputs.map(input => this.observationRecord(input)));
    const published = [];
    for (let start = 0; start < records.length; start += concurrency) {
      published.push(...await Promise.all(records.slice(start, start + concurrency).map(record => this.publish(record, 'observations'))));
    }
    if (updateIndex) await this.updateCompleteObservationIndexes(published);
    return published;
  }
  async updateCompleteObservationIndex(record) {
    return this.updateCompleteObservationIndexes([record]);
  }
  async updateCompleteObservationIndexes(records) {
    const latestCandidates = new Map(), completeCandidates = new Map();
    for (const record of records) {
      const key = observationScopeKey(record.scope);
      const latest = latestCandidates.get(key);
      if (!latest || compareObservations(record, latest) > 0) latestCandidates.set(key, record);
      if (record.coverage?.status !== 'complete') continue;
      const complete = completeCandidates.get(key);
      if (!complete || compareObservations(record, complete) > 0) completeCandidates.set(key, record);
    }
    if (!latestCandidates.size) return null;
    const update = async () => {
      const index = await this.observationIndex();
      const readCurrent = async (pointers, key) => {
        const pointer = pointers[key];
        if (!pointer) return [key, null];
        try { return [key, await this.read(pointer.id, 'observations')]; }
        catch (error) { if (error.code === 'ENOENT') return [key, null]; throw error; }
      };
      const [currentLatest, currentComplete] = await Promise.all([
        Promise.all([...latestCandidates].map(([key]) => readCurrent(index.latest, key))),
        Promise.all([...completeCandidates].map(([key]) => readCurrent(index.complete, key)))
      ]);
      const latestRecords = new Map(currentLatest), completeRecords = new Map(currentComplete);
      let changed = false;
      const latest = { ...index.latest }, complete = { ...index.complete };
      for (const [key, record] of latestCandidates) {
        const current = latestRecords.get(key);
        if (current && compareObservations(record, current) <= 0) continue;
        latest[key] = { id: record.id, scope: record.scope, observed_at: record.observed_at, content_hash: record.content_hash };
        changed = true;
      }
      for (const [key, record] of completeCandidates) {
        const current = completeRecords.get(key);
        if (current && compareObservations(record, current) <= 0) continue;
        complete[key] = { id: record.id, scope: record.scope, observed_at: record.observed_at, content_hash: record.content_hash };
        changed = true;
      }
      if (!changed) return index;
      const next = {
        schema_version: 2,
        latest: Object.fromEntries(Object.entries(latest).sort(([a], [b]) => a.localeCompare(b))),
        complete: Object.fromEntries(Object.entries(complete).sort(([a], [b]) => a.localeCompare(b)))
      };
      await atomicJSON(join(this.root, 'indexes', 'complete-observations.json'), next);
      return next;
    };
    const pending = this.observationIndexUpdating.then(update, update);
    this.observationIndexUpdating = pending.then(() => undefined, () => undefined);
    return pending;
  }
  async rebuildObservationIndex() {
    const latest = new Map(), complete = new Map();
    for (const record of await this.list('observations')) {
      const key = observationScopeKey(record.scope);
      const current = latest.get(key);
      if (!current || compareObservations(record, current) > 0) latest.set(key, record);
      if (record.coverage?.status !== 'complete') continue;
      const previous = complete.get(key);
      if (!previous || compareObservations(record, previous) > 0) complete.set(key, record);
    }
    const pointers = entries => Object.fromEntries([...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, record]) => [key, {
      id: record.id, scope: record.scope, observed_at: record.observed_at, content_hash: record.content_hash
    }]));
    const index = {
      schema_version: 2,
      latest: pointers(latest),
      complete: pointers(complete)
    };
    await this.init();
    await atomicJSON(join(this.root, 'indexes', 'complete-observations.json'), index);
    return index;
  }
  async observationIndex() {
    try {
      const index = JSON.parse(await readFile(join(this.root, 'indexes', 'complete-observations.json'), 'utf8'));
      return index.schema_version === 2 && index.latest && index.complete ? index : this.rebuildObservationIndex();
    }
    catch (error) { if (error.code === 'ENOENT') return this.rebuildObservationIndex(); throw error; }
  }
  async currentObservations() {
    const index = await this.observationIndex();
    const records = [];
    for (const pointer of Object.values(index.latest)) {
      try { records.push(await this.read(pointer.id, 'observations')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return records.sort((a, b) => compareObservations(b, a));
  }
  async completeObservation(scope) {
    const pointer = (await this.observationIndex()).complete[observationScopeKey(scope)];
    return pointer ? this.read(pointer.id, 'observations') : null;
  }
  async read(id, folder = 'snapshots') {
    return JSON.parse(await readFile(join(this.root, folder, safeId(id), 'snapshot.json'), 'utf8'));
  }
  async list(folder = 'snapshots') {
    await this.init();
    const ids = (await readdir(join(this.root, folder))).filter(id => !id.startsWith('.'));
    let records = await Promise.all(ids.map(id => this.read(id, folder)));
    if (folder === 'observations') {
      const visible = [];
      for (const record of records) {
        if (!record.commit_id) { visible.push(record); continue; }
        try { await this.read(record.commit_id, 'observations'); visible.push(record); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      records = visible;
    }
    const timestamp = row => String(row.stored_at ?? row.recorded_at ?? row.created_at ?? '');
    return records.sort((a, b) => timestamp(b).localeCompare(timestamp(a)) || b.id.localeCompare(a.id));
  }
  async historyIndex(folder) {
    if (!boundedHistoryFolders.has(folder)) throw new Error('Unsupported bounded history folder');
    try { return JSON.parse(await readFile(join(this.root, 'indexes', `history-${folder}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return this.rebuildHistoryIndex(folder); throw error; }
  }
  async rebuildHistoryIndex(folder) {
    const rows = await this.list(folder);
    const index = {
      schema_version: 1,
      folder,
      records: rows.map(row => ({ id: row.id, stored_at: row.stored_at ?? row.recorded_at ?? row.created_at ?? null }))
    };
    await atomicJSON(join(this.root, 'indexes', `history-${folder}.json`), index);
    return index;
  }
  async updateHistoryIndex(folder, record) {
    const update = async () => {
      let index;
      try { index = JSON.parse(await readFile(join(this.root, 'indexes', `history-${folder}.json`), 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        index = { schema_version: 1, folder, records: [] };
      }
      const pointer = { id: record.id, stored_at: record.stored_at ?? record.recorded_at ?? record.created_at ?? new Date().toISOString() };
      const records = [pointer, ...index.records.filter(row => row.id !== record.id)].sort((a, b) => String(b.stored_at).localeCompare(String(a.stored_at)));
      const next = { schema_version: 1, folder, records };
      await atomicJSON(join(this.root, 'indexes', `history-${folder}.json`), next);
      return next;
    };
    const previous = this.historyIndexUpdating.get(folder) ?? Promise.resolve();
    const pending = previous.then(update, update);
    this.historyIndexUpdating.set(folder, pending.then(() => undefined, () => undefined));
    return pending;
  }
  async recent(folder, limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid history limit');
    const index = await this.historyIndex(folder);
    const rows = [];
    for (const pointer of index.records.slice(0, limit)) {
      try { rows.push(await this.read(pointer.id, folder)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return rows;
  }
  async latest() {
    try { return this.read(JSON.parse(await readFile(join(this.root, 'latest.json'), 'utf8')).id); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async latestForecast() {
    try { return this.read(JSON.parse(await readFile(join(this.root, 'latest-forecast.json'), 'utf8')).id, 'forecasts'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async decision(record) {
    const saved = { ...record, id: `decision-${randomUUID()}`, stored_at: new Date().toISOString() };
    saved.content_hash = digest(saved);
    return this.publish(saved, 'decisions', `# ShotCaller decision\n\nTask: ${record.task}\n\nObserved: ${record.created_at}\n\nPrompt: ${record.prompt_hash}\n\nEvidence: ${record.snapshot_ids.join(', ')}\n\n${record.answer}\n`);
  }
  async saveForecast(forecast) {
    const inputSources = forecast?.input?.source_snapshot_ids;
    if (!forecast || !['complete', 'partial'].includes(forecast.status) || !/^[a-f0-9]{64}$/.test(forecast.input_hash || '') || !Array.isArray(forecast.source_snapshot_ids) || !forecast.source_snapshot_ids.length || !forecast.input || typeof forecast.input !== 'object' || canonicalDigest(forecast.input) !== forecast.input_hash || JSON.stringify(inputSources) !== JSON.stringify(forecast.source_snapshot_ids) || forecast.input.league_id !== forecast.league_id || forecast.input.week !== forecast.week || typeof forecast.algorithm_version !== 'string' || !forecast.algorithm_version || typeof forecast.league_id !== 'string' || !forecast.league_id || !Number.isInteger(forecast.week) || !Number.isFinite(Date.parse(forecast.created_at)) || !Array.isArray(forecast.teams) || !Array.isArray(forecast.matchups)) throw new Error('Invalid forecast');
    const saved = { schema_version: 1, kind: 'league_forecast', id: `forecast-${randomUUID()}`, stored_at: new Date().toISOString(), source_snapshot_ids: forecast.source_snapshot_ids, input_hash: forecast.input_hash, algorithm_version: forecast.algorithm_version, status: forecast.status, created_at: forecast.created_at, forecast };
    saved.content_hash = digest(forecast);
    const record = await this.publish(saved, 'forecasts');
    await atomicJSON(join(this.root, 'latest-forecast.json'), { id: record.id });
    return record;
  }
  async saveOptimization(optimization) {
    if (optimization?.kind !== 'optimization_result' || !Array.isArray(optimization.plans)) throw new Error('Invalid optimization');
    const saved = { schema_version: 1, kind: 'optimization_record', id: `optimization-${randomUUID()}`, stored_at: new Date().toISOString(), optimization };
    saved.content_hash = canonicalDigest(optimization);
    return this.publish(saved, 'optimizations');
  }
  async saveEvaluation(evaluation) {
    if (evaluation?.kind !== 'forecast_evaluation' || !['final', 'partial', 'provisional'].includes(evaluation.status) || !evaluation.correlation_key) throw new Error('Invalid forecast evaluation');
    if (evaluation.correction_of) {
      try { await this.read(evaluation.correction_of, 'evaluations'); }
      catch (error) { if (error.code === 'ENOENT') throw new Error('Evaluation correction references an unknown record'); throw error; }
    }
    const saved = { schema_version: 1, kind: 'evaluation_record', id: `evaluation-${randomUUID()}`, stored_at: new Date().toISOString(), evaluation };
    saved.content_hash = canonicalDigest(evaluation);
    return this.publish(saved, 'evaluations');
  }
  async saveReport(report) {
    if (report?.kind !== 'weekly_report' || !['final', 'partial', 'provisional'].includes(report.status) || !Number.isInteger(report.week)) throw new Error('Invalid weekly report');
    if (report.correction_of) {
      try { await this.read(report.correction_of, 'reports'); }
      catch (error) { if (error.code === 'ENOENT') throw new Error('Report correction references an unknown record'); throw error; }
    }
    const saved = { schema_version: 1, kind: 'report_record', id: `report-${randomUUID()}`, stored_at: new Date().toISOString(), report };
    saved.content_hash = canonicalDigest(report);
    const { renderWeeklyReport } = await import('./reports.mjs');
    const record = await this.publish(saved, 'reports', renderWeeklyReport(report));
    await this.updateSeasonReportIndex(report.season);
    return record;
  }
  async seasonReportIndex(season) {
    await this.init();
    const id = safeId(String(season));
    try { return JSON.parse(await readFile(join(this.root, 'indexes', `season-${id}.json`), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { schema_version: 1, kind: 'season_report_index', season: String(season), reports: [] };
    }
  }
  async updateSeasonReportIndex(season) {
    const update = async () => {
      const rows = (await this.list('reports')).filter(row => String(row.report.season) === String(season)).sort((a, b) => a.report.week - b.report.week || a.stored_at.localeCompare(b.stored_at));
      const index = { schema_version: 1, kind: 'season_report_index', season: String(season), reports: rows.map(row => ({ id: row.id, week: row.report.week, status: row.report.status, stored_at: row.stored_at, correction_of: row.report.correction_of, source_snapshot_ids: row.report.source_snapshot_ids })) };
      await atomicJSON(join(this.root, 'indexes', `season-${safeId(String(season))}.json`), index);
      const markdown = [`# Season ${season} review history`, '', ...index.reports.map(row => `- Week ${row.week} · ${row.status} · [${row.id}](../reports/${row.id}/brief.md)${row.correction_of ? ` · corrects ${row.correction_of}` : ''}`), ''].join('\n');
      await writeFile(join(this.root, 'indexes', `season-${safeId(String(season))}.md`), markdown, { mode: 0o600 });
      return index;
    };
    const pending = this.reportIndexUpdating.then(update, update);
    this.reportIndexUpdating = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
