import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../app/server.mjs';
import { configuration } from '../../app/config.mjs';

test('failed collector launch retries the same logical intention', async () => {
  const config = { ...configuration(), dataDir: await mkdtemp(join(tmpdir(), 'shotcaller-collector-ui-')), token: 'test-ui-access-token-at-least-24-characters' };
  const app = await createApp(config);
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const requests = [];
    await page.route('**/api/collector**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === '/api/collector/run') {
        const payload = request.postDataJSON(); requests.push(payload);
        const launch = requests.length === 1 ? { outcome: 'failed' } : { status: 'awaiting_artifacts' };
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ run: { id: 'run-test' }, launch }) });
      }
      if (url.pathname === '/api/collector') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ paused: true, scope: { team_id: '7', season: '2026', scoring_period: { key: '5', timezone: 'America/Los_Angeles' } }, next_run: '2026-11-15T22:00:00Z', gates_verified: true, trigger_configured: true, attempts: [] }) });
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:${app.address().port}`);
    await page.locator('#token').fill(config.token);
    await page.getByRole('button', { name: 'Connect →', exact: true }).click();
    await page.locator('[data-tab=setup]').click();
    await page.locator('#collector-run').click();
    await page.getByText(/Launch failed; retry will preserve/).waitFor();
    await page.locator('#collector-run').click();
    await page.getByText(/Launch acceptance is not evidence/).waitFor();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].intended_for, requests[1].intended_for);
  } finally { await browser.close(); await new Promise(resolve => app.close(resolve)); }
});
