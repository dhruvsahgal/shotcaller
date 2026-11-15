import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { atomicJSON, digest } from './store.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const safeRelative = value => value.split(sep).join('/');

async function filesUnder(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name.startsWith('.pending-') || entry.name.endsWith('.tmp')) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(root, path));
    else if (entry.isFile()) result.push({ path, relative: safeRelative(relative(root, path)) });
  }
  return result;
}

export async function archiveManifest(root) {
  const files = [];
  for (const file of await filesUnder(root)) {
    const content = await readFile(file.path);
    files.push({ path: file.relative, bytes: content.length, sha256: sha256(content) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { schema_version: 1, kind: 'private_archive_manifest', created_at: new Date().toISOString(), files, content_hash: digest(files) };
}

async function assertLinks(root) {
  const checks = [
    ['latest.json', 'snapshots'],
    ['latest-forecast.json', 'forecasts']
  ];
  for (const [pointer, folder] of checks) {
    let value;
    try {
      value = JSON.parse(await readFile(join(root, pointer), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    try { await stat(join(root, folder, value.id, 'snapshot.json')); }
    catch (error) { if (error.code === 'ENOENT') throw new Error(`Archive link references missing record: ${pointer}`); throw error; }
  }
  let index;
  try {
    index = JSON.parse(await readFile(join(root, 'indexes', 'complete-observations.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const observationPointers = new Map([...Object.values(index.complete || {}), ...Object.values(index.latest || {})].map(pointer => [pointer.id, pointer]));
  for (const pointer of observationPointers.values()) {
    try { await stat(join(root, 'observations', pointer.id, 'snapshot.json')); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('Archive index references missing record'); throw error; }
  }
}

export async function verifyArchive(root, manifest) {
  if (!manifest || manifest.kind !== 'private_archive_manifest' || !Array.isArray(manifest.files) || digest(manifest.files) !== manifest.content_hash) throw new Error('Invalid archive manifest');
  for (const expected of manifest.files) {
    let content;
    try { content = await readFile(join(root, expected.path)); }
    catch (error) { if (error.code === 'ENOENT') throw new Error(`Archive missing file: ${expected.path}`); throw error; }
    if (content.length !== expected.bytes || sha256(content) !== expected.sha256) throw new Error(`Archive hash mismatch: ${expected.path}`);
  }
  await assertLinks(root);
  return { ok: true, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0), content_hash: manifest.content_hash };
}

export class ModelUsageLedger {
  constructor(root, limit) {
    this.root = join(root, 'operations');
    this.file = join(this.root, 'model-usage.json');
    this.limit = limit;
    this.queue = Promise.resolve();
  }
  serial(fn) {
    const pending = this.queue.then(fn, fn);
    this.queue = pending.catch(() => {});
    return pending;
  }
  async read() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { return JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { schema_version: 1, limit: this.limit, reservations: [] };
    }
  }
  async reserve({ task, model }) {
    return this.serial(async () => {
      const ledger = await this.read();
      if (ledger.limit !== this.limit) ledger.limit = this.limit;
      if (ledger.reservations.length >= this.limit) throw new Error('Model call budget exhausted; preserve evidence and wait for a reviewed budget reset');
      const reservation = { id: `model-${randomUUID()}`, task, model, reserved_at: new Date().toISOString(), status: 'reserved', usage: null };
      ledger.reservations.push(reservation);
      await atomicJSON(this.file, ledger);
      return reservation;
    });
  }
  async settle(id, { status, usage }) {
    return this.serial(async () => {
      if (!['succeeded', 'failed'].includes(status)) throw new Error('Invalid model reservation outcome');
      const ledger = await this.read();
      const reservation = ledger.reservations.find(row => row.id === id);
      if (!reservation || reservation.status !== 'reserved') throw new Error('Unknown or already settled model reservation');
      Object.assign(reservation, { status, settled_at: new Date().toISOString(), usage: usage && typeof usage === 'object' ? usage : null });
      await atomicJSON(this.file, ledger);
      return reservation;
    });
  }
  async status() {
    const ledger = await this.read();
    const actual = ledger.reservations.reduce((sum, row) => ({
      prompt_tokens: sum.prompt_tokens + Number(row.usage?.prompt_tokens || 0),
      completion_tokens: sum.completion_tokens + Number(row.usage?.completion_tokens || 0),
      total_tokens: sum.total_tokens + Number(row.usage?.total_tokens || 0)
    }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    return { limit: ledger.limit, attempted: ledger.reservations.length, reserved: ledger.reservations.filter(row => row.status === 'reserved').length, remaining: Math.max(0, ledger.limit - ledger.reservations.length), actual };
  }
}

export class RotatingCredential {
  constructor(root, seedToken) {
    this.root = join(root, 'operations');
    this.file = join(this.root, 'collector-credential.json');
    this.seedToken = seedToken;
    this.queue = Promise.resolve();
  }
  serial(fn) {
    const pending = this.queue.then(fn, fn);
    this.queue = pending.catch(() => {});
    return pending;
  }
  digest(token, salt) { return sha256(`${salt}:${token}`); }
  async state() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { return JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!this.seedToken || this.seedToken.length < 24) return null;
      const salt = randomBytes(16).toString('hex');
      const state = { schema_version: 1, version: 1, salt, digest: this.digest(this.seedToken, salt), rotated_at: new Date().toISOString() };
      await atomicJSON(this.file, state);
      return state;
    }
  }
  async authenticate(token) {
    const state = await this.state();
    if (!state || typeof token !== 'string') return false;
    const supplied = Buffer.from(this.digest(token, state.salt));
    const expected = Buffer.from(state.digest);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  async rotate(token) {
    if (typeof token !== 'string' || token.length < 24) throw new Error('Collector token must contain at least 24 characters');
    return this.serial(async () => {
      const current = await this.state();
      const salt = randomBytes(16).toString('hex');
      const state = { schema_version: 1, version: (current?.version || 0) + 1, salt, digest: this.digest(token, salt), rotated_at: new Date().toISOString() };
      await atomicJSON(this.file, state);
      return { version: state.version, rotated_at: state.rotated_at };
    });
  }
  async status() {
    const state = await this.state();
    return state ? { configured: true, version: state.version, rotated_at: state.rotated_at } : { configured: false, version: 0, rotated_at: null };
  }
}

export async function storageHealth(root, quotaBytes = 0) {
  const files = await filesUnder(root);
  let bytes = 0, screenshotBytes = 0;
  for (const file of files) {
    const size = (await stat(file.path)).size;
    bytes += size;
    if (/\.(?:png|jpe?g|webp)$/i.test(file.relative)) screenshotBytes += size;
  }
  return { files: files.length, bytes, screenshot_bytes: screenshotBytes, quota_bytes: quotaBytes || null, quota_used_percent: quotaBytes > 0 ? Math.round(bytes / quotaBytes * 10_000) / 100 : null };
}
