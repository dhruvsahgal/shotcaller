import { chromium } from 'playwright';
import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { configuration } from './config.mjs';
import { atomicJSON } from './store.mjs';

const config = configuration();
const dir = join(config.dataDir, 'auth');
await mkdir(dir, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
try {
  const page = await context.newPage();
  await page.goto(`https://basketball.fantasysports.yahoo.com/nba/${config.leagueId}`);
  const input = createInterface({ input: stdin, output: stdout });
  await input.question('Sign in to Yahoo in the Chromium window. Once your league is visible, press Enter here. ');
  input.close();
  if (!page.url().startsWith(`https://basketball.fantasysports.yahoo.com/nba/${config.leagueId}`) || await page.locator('table').count() === 0) throw new Error('League not visible; no login state saved');
  const file = join(dir, 'yahoo.json');
  const state = await context.storageState();
  state.cookies = state.cookies.filter(c => /(^|\.)yahoo\.com$/.test(c.domain));
  state.origins = state.origins.filter(o => /(^|\.)yahoo\.com$/.test(new URL(o.origin).hostname));
  await atomicJSON(file, state); await chmod(file, 0o600);
  console.log(`Private Yahoo browser state saved to ${file}. Upload it in ShotCaller → Setup, then refresh Yahoo to verify access.`);
} finally { await browser.close(); }
