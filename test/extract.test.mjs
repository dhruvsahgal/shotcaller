import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractRosterObservation } from '../app/extract.mjs';
import { validateCollectorOutput } from '../scripts/validate-collector-output.mjs';

const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/collector/page-${name}.json`, import.meta.url), 'utf8'));
const request = {
  league: { id: '999', name: 'Synthetic League' },
  team: { id: '7', name: 'Synthetic Team' },
  scoring_period: { kind: 'week', key: '5', timezone: 'America/Los_Angeles' },
  allowed_pages: ['https://basketball.fantasysports.yahoo.com/nba/999/7']
};

test('structured roster rows retain exact source locators and explicit nulls', async () => {
  const output = extractRosterObservation(await fixture('full'), request);
  assert.equal(output.status, 'complete');
  assert.deepEqual(output.extraction.headers, ['Slot', 'Player', 'NBA Team', 'Eligibility', 'Injury']);
  assert.equal(output.extraction.source_visible_rows, 2);
  assert.deepEqual(output.roster.map(row => row.source_locator), [
    'table#roster > tbody > tr:nth-child(1)',
    'table#roster > tbody > tr:nth-child(2)'
  ]);
  assert.deepEqual(output.roster.map(row => ({
    player_id: row.player_id,
    name: row.name,
    nba_team: row.nba_team,
    eligibility: row.eligibility,
    slot: row.slot,
    injury: row.injury
  })), [
    { player_id: '101', name: 'Avery Example', nba_team: 'AAA', eligibility: ['PG', 'SG'], slot: { group: 'active', label: 'PG' }, injury: null },
    { player_id: '202', name: 'Blake Sample', nba_team: 'BBB', eligibility: ['SF', 'PF'], slot: { group: 'bench', label: 'BN' }, injury: 'GTD' }
  ]);
  assert.match(output.extraction.source_hash, /^[a-f0-9]{64}$/);
  assert.equal(validateCollectorOutput(output).status, 'complete');
});

test('clipped columns, changed headers, duplicate identities and empty rosters cannot be complete', async () => {
  for (const name of ['partial', 'changed-layout', 'duplicate', 'empty']) {
    const output = extractRosterObservation(await fixture(name), request);
    assert.equal(output.status, 'partial', name);
    assert.ok(output.warnings.length > 0, name);
    assert.equal(validateCollectorOutput(output).status, 'partial', name);
  }

  const clipped = extractRosterObservation(await fixture('partial'), request);
  assert.equal(clipped.roster[1].nba_team, null);
  assert.ok(clipped.coverage.missing_fields.includes('roster[1].nba_team'));
  assert.equal(clipped.coverage.visible_rows, 2);
  assert.equal(clipped.coverage.extracted_rows, 2);

  const duplicate = extractRosterObservation(await fixture('duplicate'), request);
  assert.match(duplicate.warnings.join(' '), /duplicate/i);
});

test('login or consent replacing the roster produces needs_login rather than empty league data', async () => {
  const output = extractRosterObservation(await fixture('login'), request);
  assert.equal(output.status, 'needs_login');
  assert.deepEqual(output.roster, []);
  assert.equal(output.coverage.visible_rows, null);
  assert.equal(output.login.required, true);
  assert.equal(output.login.challenge, 'consent');
  assert.equal(validateCollectorOutput(output).status, 'needs_login');
});

test('source reconciliation rejects a valid-looking receipt with the wrong visible total', async () => {
  const output = extractRosterObservation(await fixture('full'), request);
  output.coverage.visible_rows = 3;
  output.coverage.missing_rows = 1;
  output.status = 'partial';
  output.coverage.note = 'Synthetic incorrect visible total.';
  output.warnings = ['Synthetic incorrect visible total.'];
  assert.throws(() => validateCollectorOutput(output), /source visible row|reconciliation/i);
});

test('page inventory checkpoints must reconcile with the requested roster identity', async () => {
  const output = extractRosterObservation(await fixture('full'), request);
  output.extraction.page_inventory[0].checkpoint.team_id = '8';
  assert.throws(() => validateCollectorOutput(output), /checkpoint.*team/i);
});

test('a receipt cannot claim complete coverage with changed source headers', async () => {
  const output = extractRosterObservation(await fixture('full'), request);
  output.extraction.headers[0] = 'Lineup';
  assert.throws(() => validateCollectorOutput(output), /headers/i);
});

test('the extracted source hash must identify the terminal inventory page', async () => {
  const output = extractRosterObservation(await fixture('full'), request);
  output.extraction.source_hash = '0'.repeat(64);
  assert.throws(() => validateCollectorOutput(output), /source hash.*inventory/i);
});

test('every extracted row requires inspectable text and screenshot evidence', async () => {
  const capture = await fixture('full');
  capture.tables[0].rows[0].evidence_refs = ['evidence/full-roster.txt#row-1'];
  const output = extractRosterObservation(capture, request);
  assert.equal(output.status, 'partial');
  assert.match(output.warnings.join(' '), /row.*text.*screenshot/i);
});
