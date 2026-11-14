import { mkdir, readFile, readdir, rename, writeFile, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { historicalShapeError } from './import-validation.mjs';
import { validateIdentifier } from './schema.mjs';
import { compareObservations, observationEnvelope, observationScopeKey } from './observations.mjs';
import { attemptEnvelope, runEnvelope } from './runs.mjs';
import { canonical } from './value.mjs';

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
  }
  async init() {
    if (!this.initializing) {
      this.initializing = Promise.all(['snapshots', 'decisions', 'forecasts', 'optimizations', 'evaluations', 'reports', 'action-intents', 'action-authorizations', 'action-attempts', 'action-outcomes', 'runs', 'attempts', 'observations', 'indexes'].map(d => mkdir(join(this.root, d), { recursive: true, mode: 0o700 }))).catch(error => { this.initializing = null; throw error; });
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
  async saveObservation(input) {
    if (input?.correction_of != null) {
      try { await this.read(input.correction_of, 'observations'); }
      catch (error) { if (error.code === 'ENOENT') throw new Error('Observation correction references an unknown record'); throw error; }
    }
    const contentHash = canonicalDigest(input);
    const record = await this.publish(observationEnvelope(input, new Date().toISOString(), contentHash), 'observations');
    await this.updateCompleteObservationIndex(record);
    return record;
  }
  async updateCompleteObservationIndex(record) {
    if (record.coverage?.status !== 'complete') return null;
    const update = async () => {
      const index = await this.observationIndex();
      const key = observationScopeKey(record.scope);
      const currentPointer = index.complete[key];
      if (currentPointer) {
        try {
          const current = await this.read(currentPointer.id, 'observations');
          if (compareObservations(record, current) <= 0) return index;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      const pointer = { id: record.id, scope: record.scope, observed_at: record.observed_at, content_hash: record.content_hash };
      const complete = Object.fromEntries(Object.entries({ ...index.complete, [key]: pointer }).sort(([a], [b]) => a.localeCompare(b)));
      const next = { ...index, complete };
      await atomicJSON(join(this.root, 'indexes', 'complete-observations.json'), next);
      return next;
    };
    const pending = this.observationIndexUpdating.then(update, update);
    this.observationIndexUpdating = pending.then(() => undefined, () => undefined);
    return pending;
  }
  async rebuildObservationIndex() {
    const complete = new Map();
    for (const record of await this.list('observations')) {
      if (record.coverage?.status !== 'complete') continue;
      const key = observationScopeKey(record.scope);
      const previous = complete.get(key);
      if (!previous || compareObservations(record, previous) > 0) complete.set(key, record);
    }
    const index = {
      schema_version: 1,
      complete: Object.fromEntries([...complete.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, record]) => [key, {
        id: record.id, scope: record.scope, observed_at: record.observed_at, content_hash: record.content_hash
      }]))
    };
    await this.init();
    await atomicJSON(join(this.root, 'indexes', 'complete-observations.json'), index);
    return index;
  }
  async observationIndex() {
    try { return JSON.parse(await readFile(join(this.root, 'indexes', 'complete-observations.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return this.rebuildObservationIndex(); throw error; }
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
    const records = await Promise.all(ids.map(id => this.read(id, folder)));
    return records.sort((a, b) => b.stored_at.localeCompare(a.stored_at));
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
    if (evaluation?.kind !== 'forecast_evaluation' || !['final', 'provisional'].includes(evaluation.status) || !evaluation.correlation_key) throw new Error('Invalid forecast evaluation');
    if (evaluation.correction_of) {
      try { await this.read(evaluation.correction_of, 'evaluations'); }
      catch (error) { if (error.code === 'ENOENT') throw new Error('Evaluation correction references an unknown record'); throw error; }
    }
    const saved = { schema_version: 1, kind: 'evaluation_record', id: `evaluation-${randomUUID()}`, stored_at: new Date().toISOString(), evaluation };
    saved.content_hash = canonicalDigest(evaluation);
    return this.publish(saved, 'evaluations');
  }
  async saveReport(report) {
    if (report?.kind !== 'weekly_report' || !['final', 'provisional'].includes(report.status) || !Number.isInteger(report.week)) throw new Error('Invalid weekly report');
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
