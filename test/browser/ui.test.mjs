import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../app/server.mjs';
import { configuration } from '../../app/config.mjs';
import { Store } from '../../app/store.mjs';
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
    assert.match(await page.locator('#freshness').innerText(), /Saved observations/);
    assert.equal(await page.locator('#overview').isVisible(), true);
    assert.match(await page.locator('#overview-league').innerText(), /Example Team A/);
    assert.match(await page.locator('#overview-coverage').innerText(), /does not automatically sync/);
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
