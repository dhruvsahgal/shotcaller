import { mkdir, readFile, readdir, rename, writeFile, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { historicalShapeError } from './import-validation.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : plainObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const canonicalDigest = value => digest(canonical(value));
export function safeId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid identifier');
  return id;
}
export async function atomicJSON(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const h = await open(temp, 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(value, null, 2)); await h.sync(); }
  finally { await h.close(); }
  try { await rename(temp, file); } finally { await rm(temp, { force: true }); }
}
export class Store {
  constructor(root) { this.root = root; this.initializing = null; }
  async init() {
    if (!this.initializing) {
      this.initializing = Promise.all(['snapshots', 'decisions', 'forecasts'].map(d => mkdir(join(this.root, d), { recursive: true, mode: 0o700 }))).catch(error => { this.initializing = null; throw error; });
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
}
