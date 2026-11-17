#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { artifactLimits, ingestLimits } from '../app/ingest.mjs';
import { assessCoverage, createCoveragePlan } from '../app/coverage.mjs';
import { extractVisiblePage, parsePage } from '../app/parse.mjs';
import {
  normalizeDailyContributionRows,
  normalizeDailyLineupRows,
  normalizeMarketRows,
  normalizeMatchupRows,
  normalizePlayerPeriodRows,
  normalizeRosterRows,
  normalizeTeamPeriodRows,
  normalizeTransactionRows
} from '../app/league-page-normalize.mjs';
import { canonicalDigest } from '../app/store.mjs';
import { validateCollectorRequest } from './validate-collector-output.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safeName = value => String(value).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
const maximumText = 2_000;

async function discoverCdpUrl() {
  if (process.env.BROWSER_CDP_URL) return process.env.BROWSER_CDP_URL;
  for (const entry of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(entry)) continue;
    let command;
    try { command = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).replaceAll('\0', ' '); }
    catch { continue; }
    if (!/(?:^|\/)chrome\s/.test(command) || !command.includes('--remote-debugging-address=127.0.0.1')) continue;
    const port = command.match(/--remote-debugging-port=(\d+)/)?.[1];
    if (port) return `http://127.0.0.1:${port}`;
  }
  throw new Error('Boxes shared Browser is unavailable');
}

function compactRaw(raw, requestedUrl, observedAt) {
  return {
    requested_url: requestedUrl,
    observed_at: observedAt,
    title: raw.title,
    text: raw.text.slice(0, maximumText),
    text_truncated: raw.text.length > maximumText,
    tables: raw.tables,
    controls: raw.controls,
    next: raw.next,
    next_disabled: raw.next_disabled
  };
}

function fragment({ run, segment, source, url, observedAt, rows, status = 'complete', pageKey = 'first', terminal = true, nextPageKey = null, reportedTotalRows = rows.length }) {
  return {
    id: `fragment-${canonicalDigest({ run: run.id, segment: segment.id, url, pageKey, observedAt }).slice(0, 24)}`,
    collection_id: run.id,
    segment_id: segment.id,
    scope: structuredClone(segment.scope),
    filters: structuredClone(segment.filters),
    page_key: pageKey,
    terminal,
    next_page_key: nextPageKey,
    status,
    observed_at: observedAt,
    source: { id: source.id, url, hash: source.hash },
    evidence_refs: [`${source.evidence_ref}#${segment.id}-${pageKey}`],
    reported_total_rows: reportedTotalRows,
    rows
  };
}

function sourceUrl(base, segment) {
  const dataset = segment.scope.dataset;
  if (['team_roster', 'player_period_stats'].includes(dataset)) return `${base}/${segment.scope.team_id}`;
  if (['daily_lineup', 'daily_contributions'].includes(dataset)) return `${base}/${segment.scope.team_id}?date=${segment.scope.scoring_period.key}`;
  if (dataset === 'matchups') return `${base}/matchup?week=${segment.scope.scoring_period.key}&module=matchup&mid1=${segment.expected_team_ids[0]}`;
  if (dataset === 'team_period_stats') return `${base}/teamstats`;
  if (dataset === 'market') return `${base}/players?status=${segment.filters.availability}`;
  return `${base}/transactions`;
}

function groupFor(segment) {
  if (segment.scope.team_id) return `team-${safeName(segment.scope.team_id)}`;
  if (segment.scope.dataset === 'market') return `market-${segment.filters.availability.toLowerCase()}`;
  if (segment.scope.dataset === 'transactions') return 'transactions';
  return 'league';
}

function sourceArtifact(group, pages) {
  const evidence_ref = `evidence/source-${safeName(group)}.txt`;
  const bytes = Buffer.from(JSON.stringify({ version: 1, group, pages }));
  if (bytes.length > artifactLimits.source_text) throw new Error(`Source evidence group ${group} exceeds its private artifact bound`);
  return { id: `source-${safeName(group)}`, class: 'source_text', evidence_ref, bytes, hash: sha256(bytes) };
}

function normalizeForSegment(segment, parsed) {
  switch (segment.scope.dataset) {
    case 'team_roster': return normalizeRosterRows(parsed, segment.scope.team_id);
    case 'player_period_stats': return normalizePlayerPeriodRows(parsed, segment.scope.team_id);
    case 'daily_lineup': return normalizeDailyLineupRows(parsed, segment.scope.team_id);
    case 'daily_contributions': return normalizeDailyContributionRows(parsed, segment.scope.team_id);
    case 'matchups': return normalizeMatchupRows(parsed, segment.expected_team_ids);
    case 'team_period_stats': return normalizeTeamPeriodRows(parsed, segment.expected_team_ids);
    case 'market': return normalizeMarketRows(parsed, segment.filters.availability);
    case 'transactions': return normalizeTransactionRows(parsed);
    default: return [];
  }
}

function parseKind(dataset) {
  if (['team_roster', 'player_period_stats', 'daily_lineup', 'daily_contributions'].includes(dataset)) return 'roster';
  if (dataset === 'matchups') return 'matchup';
  if (dataset === 'team_period_stats') return 'teamstats';
  if (dataset === 'market') return 'players';
  return 'transactions';
}

export async function captureBoxesLeagueBundle({ run, artifactRoot, cdpUrl = null, now = () => new Date() }) {
  if (!run?.collection_plan || !Array.isArray(run.allowed_pages)) throw new Error('Invalid league run metadata');
  const plan = createCoveragePlan(run.collection_plan);
  const base = `https://basketball.fantasysports.yahoo.com/nba/${plan.league_id}`;
  const browser = await chromium.connectOverCDP(cdpUrl || await discoverCdpUrl(), { timeout: 20_000 });
  const context = browser.contexts()[0];
  if (!context) { await browser.close(); throw new Error('Boxes shared Browser has no authenticated context'); }
  const page = await context.newPage();
  await page.route('**/*', route => {
    const request = route.request();
    const host = new URL(request.url()).hostname;
    const disposable = ['image', 'media', 'font'].includes(request.resourceType());
    const advertising = /(?:doubleclick|googlesyndication|googleadservices|adtrafficquality|casalemedia|onetag-sys|2mdn)\./.test(host);
    return disposable || advertising ? route.abort() : route.continue();
  });
  const pagesByGroup = new Map(), captures = new Map(), warnings = [];
  let loginRequired = false;

  const visit = async (url, group) => {
    if (captures.has(url)) return captures.get(url);
    const guard = validateCollectorRequest({ method: 'GET', url, allowedPages: run.allowed_pages });
    if (!guard.allowed) {
      warnings.push(`${group}: page omitted because it is outside the immutable run allow-list`);
      return null;
    }
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      if (response && !response.ok()) throw new Error(`HTTP ${response.status()}`);
      await page.locator('table, input[type=password], form[action*="login"]').first().waitFor({ timeout: 3_000 }).catch(() => {});
      const raw = await page.evaluate(extractVisiblePage);
      if (/login\.yahoo|consent\.yahoo/.test(raw.url) || /sign in to (?:view|access|continue)/i.test(raw.text)) {
        loginRequired = true;
        throw new Error('Yahoo login required');
      }
      const observedAt = now().toISOString();
      const captured = { raw, observedAt, requestedUrl: url, group };
      captures.set(url, captured);
      if (!pagesByGroup.has(group)) pagesByGroup.set(group, []);
      pagesByGroup.get(group).push(compactRaw(raw, url, observedAt));
      return captured;
    } catch (error) {
      warnings.push(`${group}: ${/login required/i.test(error.message) ? 'Yahoo login required' : 'page capture incomplete'}`);
      return null;
    }
  };

  try {
    await visit(base, 'league');
    for (const segment of plan.segments.filter(row => !['market', 'transactions'].includes(row.scope.dataset))) await visit(sourceUrl(base, segment), groupFor(segment));

    for (const dataset of ['market', 'transactions']) {
      const segment = plan.segments.find(row => row.scope.dataset === dataset);
      const candidates = dataset === 'market' ? plan.segments.filter(row => row.scope.dataset === dataset) : [segment];
      for (const candidate of candidates) {
        const group = groupFor(candidate);
        let url = sourceUrl(base, candidate), count = 0;
        while (url && count < 40) {
          const captured = await visit(url, group);
          if (!captured) break;
          const next = captured.raw.next;
          if (!next || !validateCollectorRequest({ method: 'GET', url: next, allowedPages: run.allowed_pages }).allowed) break;
          url = next; count += 1;
        }
      }
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const evidenceDir = join(artifactRoot, 'evidence');
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const sources = [];
  for (const [group, pages] of [...pagesByGroup].sort(([a], [b]) => a.localeCompare(b))) {
    const artifact = sourceArtifact(group, pages);
    await writeFile(join(artifactRoot, artifact.evidence_ref), artifact.bytes, { mode: 0o600 });
    sources.push(artifact);
  }
  const sourceByGroup = new Map(sources.map(source => [source.id.slice('source-'.length), source]));
  const sourceForGroup = group => sourceByGroup.get(safeName(group));
  const fragments = [];

  for (const segment of plan.segments.filter(row => !['market', 'transactions'].includes(row.scope.dataset))) {
    const url = sourceUrl(base, segment), captured = captures.get(url), source = sourceForGroup(groupFor(segment));
    if (!captured || !source) continue;
    let parsed;
    try { parsed = parsePage(captured.raw, parseKind(segment.scope.dataset), segment.scope.team_id); }
    catch { warnings.push(`${segment.scope.dataset}: source parsing incomplete`); continue; }
    const rows = normalizeForSegment(segment, parsed);
    const periodUnverified = segment.scope.dataset === 'player_period_stats';
    const contributionDate = segment.scope.dataset === 'daily_contributions' ? segment.scope.scoring_period.key : null;
    const dayNotFinal = contributionDate && Date.parse(`${contributionDate}T23:59:59-08:00`) >= now().getTime();
    const status = parsed.warnings.length || periodUnverified || dayNotFinal ? 'partial' : 'complete';
    fragments.push(fragment({ run, segment, source, url, observedAt: captured.observedAt, rows, status }));
    warnings.push(...parsed.warnings.map(message => `${segment.scope.dataset}: ${message}`));
    if (periodUnverified) warnings.push(`player_period_stats/${segment.scope.team_id}: Yahoo weekly period was not independently verified`);
  }

  for (const segment of plan.segments.filter(row => ['market', 'transactions'].includes(row.scope.dataset))) {
    const group = groupFor(segment), source = sourceForGroup(group);
    if (!source) continue;
    const groupPages = [...captures.values()].filter(item => item.group === group);
    const provisional = [];
    for (let index = 0; index < groupPages.length; index += 1) {
      const captured = groupPages[index];
      let parsed;
      try { parsed = parsePage(captured.raw, parseKind(segment.scope.dataset)); }
      catch { continue; }
      provisional.push({ captured, parsed, rows: normalizeForSegment(segment, parsed), pageKey: index ? `page-${index + 1}` : 'first' });
    }
    const total = provisional.reduce((sum, item) => sum + item.rows.length, 0);
    for (let index = 0; index < provisional.length; index += 1) {
      const item = provisional[index], terminal = index === provisional.length - 1 && !item.captured.raw.next;
      fragments.push(fragment({
        run, segment, source, url: item.captured.requestedUrl, observedAt: item.captured.observedAt, rows: item.rows,
        status: item.parsed.warnings.length || !terminal ? 'partial' : 'complete', pageKey: item.pageKey, terminal,
        nextPageKey: terminal ? null : `page-${index + 2}`, reportedTotalRows: total
      }));
      warnings.push(...item.parsed.warnings.map(message => `${segment.scope.dataset}: ${message}`));
    }
  }

  if (loginRequired && !fragments.length) throw new Error('Yahoo login required in the Boxes shared Browser');
  if (!fragments.length) throw new Error('No usable Yahoo table fragments were captured');
  const coverage = assessCoverage(plan, fragments);
  const capture = { version: 1, plan, fragments };
  const observedAt = fragments.map(row => row.observed_at).sort().at(-1);
  const leagueTitle = pagesByGroup.get('league')?.[0]?.title?.split('|')[0]?.trim() || `Yahoo league ${plan.league_id}`;
  const output = {
    contract_version: 2,
    collector_mode: 'observation_only',
    decision_output: false,
    status: coverage.status,
    league: { id: plan.league_id, name: leagueTitle },
    collection_id: run.id,
    plan_hash: canonicalDigest(plan),
    allowed_pages: run.allowed_pages,
    source: { observed_at: observedAt, evidence_refs: sources.map(source => source.evidence_ref), source_hash: canonicalDigest(capture) },
    fragment_count: fragments.length,
    coverage_hash: canonicalDigest(coverage),
    login: { required: false, challenge: null },
    warnings: [...new Set(warnings)]
  };
  if (output.status === 'complete') output.warnings = [];
  const core = [
    { id: 'output', class: 'collector_output', evidence_ref: 'evidence/collector-output.json', bytes: Buffer.from(JSON.stringify(output)) },
    { id: 'capture', class: 'structured_capture', evidence_ref: 'evidence/structured-capture.json', bytes: Buffer.from(JSON.stringify(capture)) }
  ];
  const files = [...core, ...sources];
  if (files.length > ingestLimits.count || files.reduce((sum, file) => sum + file.bytes.length, 0) > ingestLimits.total) throw new Error('Collector bundle exceeds the private ingest bound');
  for (const file of core) {
    if (file.bytes.length > artifactLimits[file.class]) throw new Error(`${file.class} exceeds its private artifact bound`);
    await writeFile(join(artifactRoot, file.evidence_ref), file.bytes, { mode: 0o600 });
  }
  const manifest = {
    version: 1,
    run_id: run.id,
    attempt_id: `collector-browser-${randomUUID()}`,
    idempotency_key: run.idempotency_key,
    league_id: plan.league_id,
    artifacts: files.map(file => ({ id: file.id, class: file.class, evidence_ref: file.evidence_ref, bytes: file.bytes.length, sha256: sha256(file.bytes) }))
  };
  await writeFile(join(artifactRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { status: output.status, fragments: fragments.length, usable_rows: fragments.reduce((sum, item) => sum + item.rows.length, 0), coverage, manifest };
}

async function main(argv) {
  if (argv.length !== 2) throw new Error('Usage: capture-boxes-league-bundle <run.json> <artifact-root>');
  const [runPath, artifactRoot] = argv;
  const result = await captureBoxesLeagueBundle({ run: JSON.parse(await readFile(runPath, 'utf8')), artifactRoot: resolve(artifactRoot) });
  process.stdout.write(`${JSON.stringify({ status: result.status, fragments: result.fragments, usable_rows: result.usable_rows })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
