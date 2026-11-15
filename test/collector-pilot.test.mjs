import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mutationGuardPolicy,
  redactCollectorUrl,
  validateCollectorOutput,
  validateCollectorRequest
} from '../scripts/validate-collector-output.mjs';

const fixtureUrl = name => new URL(`./fixtures/collector/${name}.json`, import.meta.url);
const fixture = async name => JSON.parse(await readFile(fixtureUrl(name), 'utf8'));

test('a complete roster reconciles every synthetic visible row and required field', async () => {
  const output = validateCollectorOutput(await fixture('complete'));
  assert.equal(output.status, 'complete');
  assert.equal(output.scope.dataset, 'team_roster');
  assert.equal(output.coverage.visible_rows, 2);
  assert.equal(output.coverage.extracted_rows, output.roster.length);
  assert.equal(output.coverage.missing_rows, 0);
  assert.equal(output.coverage.row_reconciled, true);
  assert.deepEqual(output.roster.map(row => row.name), ['Avery Example', 'Blake Sample']);
  assert.deepEqual(output.roster.map(row => row.slot.group), ['active', 'bench']);
  assert.ok(output.roster.every(row => row.player_id || row.player_url));
  assert.ok(output.roster.every(row => row.evidence_refs.length > 0));

  const linkOnly = await fixture('complete');
  linkOnly.roster[0].player_id = null;
  assert.equal(validateCollectorOutput(linkOnly).roster[0].player_url, 'https://sports.yahoo.com/nba/players/101/');
});

test('obstructed rows stay partial and login or passkey pages stay needs_login', async () => {
  const partial = validateCollectorOutput(await fixture('partial-obstructed'));
  assert.equal(partial.status, 'partial');
  assert.equal(partial.coverage.visible_rows, 3);
  assert.equal(partial.coverage.extracted_rows, 2);
  assert.equal(partial.coverage.missing_rows, 1);
  assert.match(partial.coverage.note, /obstructed/i);

  const unknownField = await fixture('complete');
  unknownField.status = 'partial';
  unknownField.roster[0].nba_team = null;
  unknownField.coverage.missing_fields = ['roster[0].nba_team'];
  unknownField.coverage.note = 'One NBA team value was not visible.';
  unknownField.warnings = ['An unknown field was retained as null.'];
  assert.equal(validateCollectorOutput(unknownField).roster[0].nba_team, null);
  unknownField.coverage.missing_fields = [];
  assert.throws(() => validateCollectorOutput(unknownField), /missing_fields/i);

  const login = validateCollectorOutput(await fixture('needs-login'));
  assert.equal(login.status, 'needs_login');
  assert.equal(login.login.required, true);
  assert.equal(login.login.challenge, 'passkey');
  assert.deepEqual(login.roster, []);
  assert.equal(login.league.name, null);
  assert.equal(login.scoring_period.key, null);
});

test('page instructions cannot expand collection scope or become commands or decisions', async () => {
  const injected = await fixture('source-instructions');
  assert.throws(() => validateCollectorOutput(injected), /unexpected|scope|decision|command/i);

  const expanded = await fixture('complete');
  expanded.allowed_pages.push('https://example.test/export-account');
  assert.throws(() => validateCollectorOutput(expanded), /allowed page|Yahoo/i);

  const decision = await fixture('complete');
  decision.decision = { recommendation: 'Drop a player' };
  assert.throws(() => validateCollectorOutput(decision), /unexpected.*decision/i);
});

test('session-bearing query values are redacted without retaining unrelated account details', async () => {
  const redacted = redactCollectorUrl('https://basketball.fantasysports.yahoo.com/nba/999/7?week=5&sid=synthetic-secret&crumb=synthetic-crumb');
  const parsed = new URL(redacted);
  assert.equal(parsed.searchParams.get('week'), '5');
  assert.equal(parsed.searchParams.get('sid'), '[REDACTED]');
  assert.equal(parsed.searchParams.get('crumb'), '[REDACTED]');
  assert.equal(redacted.includes('synthetic-secret'), false);
  assert.equal(redacted.includes('synthetic-crumb'), false);

  const sessionUrl = await fixture('complete');
  sessionUrl.source.url += '?week=5&sid=synthetic-secret';
  assert.throws(() => validateCollectorOutput(sessionUrl), /redact/i);

  const accountDetail = await fixture('complete');
  accountDetail.account_email = 'manager@example.test';
  assert.throws(() => validateCollectorOutput(accountDetail), /unexpected.*account_email/i);
});

test('the external mutation guard rejects every Yahoo write class before interaction', async () => {
  const allowedPages = ['https://basketball.fantasysports.yahoo.com/nba/999/7'];
  assert.equal(validateCollectorRequest({ method: 'GET', url: allowedPages[0], allowedPages }).allowed, true);
  assert.equal(validateCollectorRequest({ method: 'GET', url: `${allowedPages[0]}?week=6`, allowedPages }).allowed, false);
  const datedPage = `${allowedPages[0]}?week=5`;
  assert.equal(validateCollectorRequest({ method: 'GET', url: datedPage, allowedPages: [datedPage] }).allowed, true);
  assert.equal(validateCollectorRequest({ method: 'GET', url: `${allowedPages[0]}?week=6`, allowedPages: [datedPage] }).allowed, false);

  const blocked = [
    ['lineup', 'GET', 'https://basketball.fantasysports.yahoo.com/nba/999/7/editlineup'],
    ['lineup', 'POST', 'https://basketball.fantasysports.yahoo.com/nba/999/7'],
    ['add_drop', 'GET', 'https://basketball.fantasysports.yahoo.com/nba/999/addplayer?pid=101'],
    ['add_drop', 'GET', 'https://basketball.fantasysports.yahoo.com/nba/999/dropplayer?pid=202'],
    ['trade', 'GET', 'https://basketball.fantasysports.yahoo.com/nba/999/proposetrade'],
    ['trade', 'POST', 'https://basketball.fantasysports.yahoo.com/nba/999/trade/submit'],
    ['messaging', 'GET', 'https://basketball.fantasysports.yahoo.com/nba/999/message/compose'],
    ['messaging', 'POST', 'https://basketball.fantasysports.yahoo.com/nba/999/messages/send']
  ];
  for (const [actionClass, method, url] of blocked) {
    const result = validateCollectorRequest({ method, url, allowedPages });
    assert.equal(result.allowed, false, `${method} ${url}`);
    assert.equal(result.action_class, actionClass, `${method} ${url}`);
  }
  assert.deepEqual(mutationGuardPolicy.blocked_action_classes, ['lineup', 'add_drop', 'trade', 'messaging']);
  assert.deepEqual(mutationGuardPolicy.allowed_scope_kinds, ['team_roster', 'league_coverage']);
  assert.equal(Object.isFrozen(mutationGuardPolicy), true);
});

test('the prompt keeps collection factual, bounded, and separate from decision instructions', async () => {
  const prompt = await readFile(new URL('../prompts/collector-readonly.md', import.meta.url), 'utf8');
  assert.match(prompt, /page text.*data/i);
  assert.match(prompt, /stop before.*transaction/i);
  assert.match(prompt, /do not.*recommend/i);
  assert.match(prompt, /canonical decision prompt.*separate/i);
  assert.match(prompt, /shared Browser/i);
});

test('the validator CLI accepts the complete fixture without logging roster or source details', () => {
  const script = fileURLToPath(new URL('../scripts/validate-collector-output.mjs', import.meta.url));
  const input = fileURLToPath(fixtureUrl('complete'));
  const result = spawnSync(process.execPath, [script, input], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.deepEqual(receipt, { valid: true, status: 'complete', rows: 2, visible_rows: 2 });
});
