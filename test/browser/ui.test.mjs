import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../app/server.mjs';
import { configuration } from '../../app/config.mjs';
import { Store } from '../../app/store.mjs';
import { buildWeeklyReport } from '../../app/reports.mjs';
test('desktop and mobile dashboard exposes provenance, historical ranks and the canonical prompt', async () => {
  const config = { ...configuration(), dataDir: await mkdtemp(join(tmpdir(), 'shotcaller-ui-')), token: 'test-ui-access-token-at-least-24-characters' };
  const store = new Store(config.dataDir);
  const first = await store.importHistorical({
    snapshot_id: 'browser-test-week1', kind: 'league_weekly_category_totals', week: 1,
    source: { captured_at: '2026-10-25T12:00:00Z', type: 'synthetic_test_fixture' },
    coverage: { week: 1 },
    teams: [
      { name: 'Example Team A', stats: { fg_pct: .480, ft_pct: .810, three_pm: 60, pts: 600, oreb: 50, reb: 240, ast: 140, st: 40, blk: 30 } },
      { name: 'Example opponent', stats: { fg_pct: .450, ft_pct: .790, three_pm: 40, pts: 550, oreb: 30, reb: 190, ast: 170, st: 30, blk: 25 } }
    ]
  });
  const second = await store.importHistorical({ ...first.payload, snapshot_id: 'browser-test-alternate-source' });
  await store.importHistorical({snapshot_id:'partial-lineup',source:{type:'synthetic'},kind:'daily_lineup_audit',observed_date:'2026-10-30',days:[{date:'2026-10-30'},{date:'2026-10-31',playing_in_active_slots:[],benched_with_game:[],conflict:false}]});
  await store.importHistorical({
    snapshot_id: 'browser-test-matchup', kind: 'matchup_weekly_category_totals', observed_at: '2026-10-30T12:00:00Z', week: 1,
    source: { captured_at: '2026-10-30T12:00:00Z', type: 'synthetic_test_fixture' },
    teams: first.payload.teams
  });
  await store.saveObservation({
    id: 'observation-ui-empty-scan',
    source: { id: 'synthetic-source', hash: 'a'.repeat(64) },
    observed_at: '2026-11-16T15:13:00Z',
    observed_at_precision: 'instant',
    scope: {
      dataset: 'matchups', league_id: config.leagueId, season: '2026', team_id: null, matchup_id: 'matchup-1',
      scoring_period: { kind: 'week', key: '5', timezone: 'America/Los_Angeles' },
      value_basis: { value: 'actual', aggregation: 'totals' }
    },
    coverage: { status: 'partial', note: 'Required matchup dataset is unexpectedly empty' },
    parser_version: 'synthetic-test',
    data: { rows: [], fragments: [{ collection_id: 'run-ui-empty-scan', rows: [] }] },
    links: {}
  });
  await store.saveEvaluation({ schema_version: 1, kind: 'forecast_evaluation', status: 'final', evaluated_at: '2026-11-17T08:00:00Z', forecast_id: 'forecast-fixture', league_id: config.leagueId, season: '2026', week: 4, correlation_key: `${config.leagueId}:2026:4`, independent_validation_units: 1, source_snapshot_ids: ['ui-shared-source'], caveats: [], matchups: [] });
  await store.saveReport(buildWeeklyReport({ league_id: config.leagueId, season: '2026', week: 4, expected_matchups: 1, matchups: [{ id: 'm1', status: 'final', source_snapshot_ids: ['ui-shared-source'], teams: [] }], evaluations: [], decisions: [], actions: [], lineup_days: [] }));
  const app = await createApp(config, { store });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${app.address().port}`);
    await page.locator('#token').fill(config.token);
    await page.getByRole('button', { name: 'Connect →', exact: true }).click();
    await page.locator('#workspace').waitFor({ state: 'visible' });
    const freshness = await page.locator('#freshness').innerText();
    assert.match(freshness, /Yahoo scan captured 2026-11-16T15:13:00Z/);
    assert.match(freshness, /0\/1 datasets contained normalized rows/);
    assert.match(freshness, /Older structured panels remain visible/);
    assert.equal(await page.locator('#signal').innerText(), 'SCAN INCOMPLETE');
    assert.equal(await page.locator('#overview').isVisible(), true);
    assert.match(await page.locator('#overview-content').innerText(), /latest Yahoo scan/i);
    assert.match(await page.locator('#overview-matchup').innerText(), /historical/i);
    assert.match(await page.locator('#overview-matchup').innerText(), /should not be read as the current score/i);
    assert.match(await page.locator('#overview-league').innerText(), /Example Team A/);
    assert.match(await page.locator('#overview-coverage').innerText(), /does not automatically sync/);
    await page.locator('[data-tab=matchup]').click();
    assert.match(await page.locator('#matchup-intelligence').innerText(), /ui-shared-source/);
    assert.match(await page.locator('#matchup-intelligence').innerText(), /1 independent finalized week/);
    const operationsRefresh = page.waitForRequest(request => new URL(request.url()).pathname === '/api/operations');
    await page.locator('[data-tab=setup]').click();
    await operationsRefresh;
    assert.match(await page.locator('#operations-intelligence').innerText(), /Live roster mutations\s+Disabled/);
    await page.locator('#collector-season').fill('2026');
    await page.locator('#collector-week').fill('5');
    await page.locator('#collector-start-date').fill('2026-11-16');
    await page.locator('#collector-teams').fill('1,2,3,4,5,6,7,8,9,10');
    await page.locator('#collector-matchups').fill('1-2,3-4,5-6,7-8,9-10');
    const planRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/collector/settings' && request.method() === 'POST');
    await page.locator('#collector-form button').click();
    const planBody = JSON.parse((await planRequest).postData());
    assert.deepEqual(planBody.plan.transaction_window, { start: '2026-11-09T00:00:00.000Z', end: '2026-11-23T00:00:00.000Z' });
    await page.locator('[data-tab=overview]').click();
    const lineupRows=await page.locator('#overview-lineups tbody tr').allTextContents();
    assert.match(lineupRows[0],/Not captured/);
    assert.equal(lineupRows[0].includes('None observed'),false);
    assert.match(lineupRows[1],/None observed/);
    await page.locator('[data-tab=league]').click();
    assert.match(await page.locator('#league-content').innerText(), /Example Team A/);
    assert.match(await page.locator('#league-content').innerText(), /HISTORICAL WEEK 1/);
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/shotcaller-desktop.png', fullPage: true });
    await page.locator('[data-tab=system]').click();
    assert.match(await page.locator('#prompt-text').innerText(), /You are ShotCaller/);
    await page.locator('[data-tab=decisions]').click();
    assert.equal(await page.locator('#ask').isDisabled(), true);
    await page.locator('[data-tab=setup]').click();
    await page.locator('#setup-model').fill('example-model');
    await page.locator('#setup-key').fill('test-provider-key-not-real');
    await page.getByRole('button', { name: 'Save model', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('setup-status').textContent === 'Saved to your private volume.');
    assert.match(await page.locator('#operations-intelligence').innerText(), /Private volume/);
    assert.equal(await page.locator('#setup-key').inputValue(), '');
    assert.match(await page.locator('#key-status').innerText(), /saved privately/);
    await page.screenshot({ path: 'test-results/shotcaller-setup-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: 'test-results/shotcaller-setup-mobile.png', fullPage: true });
    await page.locator('[data-tab=overview]').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: 'test-results/shotcaller-overview-mobile.png', fullPage: true });
    await page.locator('[data-tab=evidence]').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: 'test-results/shotcaller-mobile.png', fullPage: true });
    let release, arrived;
    const held = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { arrived = resolve; });
    await page.route(`**/api/snapshots/${first.id}`, async route => { arrived(); await held; await route.continue(); });
    await page.locator(`[data-id="${first.id}"]`).click();
    await requested;
    await page.locator(`[data-id="${second.id}"]`).click();
    await page.waitForFunction(id => document.getElementById('snapshot-meta').textContent.includes(id), second.id);
    const delayedResponse = page.waitForResponse(response => response.url().endsWith(first.id));
    release();
    await (await delayedResponse).finished();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.match(await page.locator('#snapshot-meta').innerText(), new RegExp(second.id));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => app.close(resolve)); }
});
