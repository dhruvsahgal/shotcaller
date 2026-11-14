import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectBoundedRoster, collectDatasetSegment } from '../app/collector.mjs';
import { validateCollectorOutput } from '../scripts/validate-collector-output.mjs';

const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/collector/page-${name}.json`, import.meta.url), 'utf8'));
const request = {
  league: { id: '999', name: 'Synthetic League' },
  team: { id: '7', name: 'Synthetic Team' },
  scoring_period: { kind: 'week', key: '5', timezone: 'America/Los_Angeles' },
  allowed_pages: ['https://basketball.fantasysports.yahoo.com/nba/999/7']
};

test('a bounded structured capture returns a complete factual receipt without decision output', async () => {
  const page = await fixture('full');
  const result = await collectBoundedRoster({
    request,
    observe: async () => page,
    limits: { max_steps: 3, max_elapsed_ms: 1_000, max_source_tokens: 20_000, max_repeated_captures: 2 }
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.decision_output, false);
  assert.equal(result.extraction.page_inventory.length, 1);
  assert.equal(validateCollectorOutput(result).status, 'complete');
});

test('repeated screenshots and stalled navigation exhaust a mechanical bound and return partial', async () => {
  const loading = await fixture('full');
  loading.ready = false;
  let calls = 0;
  const result = await collectBoundedRoster({
    request,
    observe: async () => { calls += 1; return structuredClone(loading); },
    limits: { max_steps: 5, max_elapsed_ms: 1_000, max_source_tokens: 20_000, max_repeated_captures: 2 }
  });
  assert.equal(calls, 3);
  assert.equal(result.status, 'partial');
  assert.match(result.warnings.join(' '), /repeated|stalled/i);
  assert.equal(result.extraction.page_inventory.length, 3);
  assert.equal(validateCollectorOutput(result).status, 'partial');
});

test('step, time and source-token limits are enforced outside observation judgment', async () => {
  const loading = await fixture('full');
  loading.ready = false;
  let elapsed = 0;
  const timed = await collectBoundedRoster({
    request,
    observe: async () => { elapsed += 20; return { ...structuredClone(loading), observed_at: `2026-11-14T10:15:${30 + elapsed / 20}Z` }; },
    now: () => elapsed,
    limits: { max_steps: 10, max_elapsed_ms: 30, max_source_tokens: 20_000, max_repeated_captures: 10 }
  });
  assert.equal(timed.status, 'partial');
  assert.match(timed.warnings.join(' '), /time limit/i);

  let steps = 0;
  const stepLimited = await collectBoundedRoster({
    request,
    observe: async () => {
      steps += 1;
      return { ...structuredClone(loading), observed_at: `2026-11-14T10:16:0${steps}Z` };
    },
    limits: { max_steps: 2, max_elapsed_ms: 1_000, max_source_tokens: 20_000, max_repeated_captures: 10 }
  });
  assert.equal(steps, 2);
  assert.equal(stepLimited.status, 'partial');
  assert.match(stepLimited.warnings.join(' '), /step limit/i);

  const oversized = await fixture('full');
  oversized.text = 'x'.repeat(100);
  const tokenLimited = await collectBoundedRoster({
    request,
    observe: async () => oversized,
    limits: { max_steps: 3, max_elapsed_ms: 1_000, max_source_tokens: 10, max_repeated_captures: 2 }
  });
  assert.equal(tokenLimited.status, 'partial');
  assert.match(tokenLimited.warnings.join(' '), /source token limit/i);
});

test('observation deadlines interrupt stalled adapters and cumulative captures share one token budget', async () => {
  await assert.rejects(collectBoundedRoster({ request, observe: async () => new Promise(() => {}), limits: { max_elapsed_ms: 10 } }), /timed out/);

  const loading = await fixture('full'); loading.ready = false;
  let calls = 0;
  const perCapture = Math.ceil(JSON.stringify(loading).length / 4);
  const bounded = await collectBoundedRoster({
    request,
    observe: async () => { calls += 1; return { ...structuredClone(loading), observed_at: `2026-11-14T10:17:0${calls}Z` }; },
    limits: { max_steps: 5, max_elapsed_ms: 1_000, max_source_tokens: Math.floor(perCapture * 1.5), max_repeated_captures: 5 }
  });
  assert.equal(calls, 2);
  assert.equal(bounded.status, 'partial');
  assert.match(bounded.warnings.join(' '), /source token limit/i);

  const segment = { id: 'segment-test', scope: { dataset: 'market', league_id: '999', season: '2026', team_id: null, matchup_id: null, scoring_period: request.scoring_period, value_basis: { value: 'actual', aggregation: 'snapshot' } }, filters: { availability: 'FA' }, expected_team_ids: null };
  const dataset = await collectDatasetSegment({ segment, observe: async () => new Promise(() => {}), limits: { max_elapsed_ms: 10 } });
  assert.equal(dataset.status, 'partial');
  assert.match(dataset.issues.join(' '), /time limit/i);
});
