import { canonicalDigest } from './store.mjs';
import { extractRosterObservation, forcePartialReceipt } from './extract.mjs';

const defaults = Object.freeze({ max_steps: 5, max_elapsed_ms: 30_000, max_source_tokens: 40_000, max_repeated_captures: 2 });

function boundedInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${label}`);
  return value;
}

function limitsOf(input = {}) {
  const limits = { ...defaults, ...input };
  boundedInteger(limits.max_steps, 'collector step limit', 50);
  boundedInteger(limits.max_elapsed_ms, 'collector elapsed-time limit', 10 * 60_000);
  boundedInteger(limits.max_source_tokens, 'collector source-token limit', 250_000);
  boundedInteger(limits.max_repeated_captures, 'collector repeated-capture limit', 10);
  return limits;
}

function estimatedTokens(capture) {
  return Math.ceil(JSON.stringify(capture).length / 4);
}

function captureSignature(capture) {
  const stable = structuredClone(capture);
  delete stable.observed_at;
  return canonicalDigest(stable);
}

export async function collectBoundedRoster({ request, observe, limits: limitInput, now = () => Date.now() }) {
  if (typeof observe !== 'function') throw new Error('Collector requires an observation function');
  const limits = limitsOf(limitInput);
  const startedAt = now();
  const signatures = new Map();
  const inventory = [];
  let lastExtracted = null;

  for (let step = 1; step <= limits.max_steps; step += 1) {
    const capture = await observe({ step, url: request.allowed_pages[0] });
    const extracted = extractRosterObservation(capture, request);
    lastExtracted = extracted;
    inventory.push(extracted.extraction.page_inventory[0]);
    if (extracted.status === 'needs_login') return { ...extracted, extraction: { ...extracted.extraction, page_inventory: inventory } };
    if (estimatedTokens(capture) > limits.max_source_tokens) return forcePartialReceipt(extracted, 'Collector source token limit reached; coverage is incomplete.', inventory);
    if (now() - startedAt > limits.max_elapsed_ms) return forcePartialReceipt(extracted, 'Collector time limit reached; coverage is incomplete.', inventory);
    if (capture.ready !== false) return { ...extracted, extraction: { ...extracted.extraction, page_inventory: inventory } };

    const signature = captureSignature(capture);
    const repeats = (signatures.get(signature) ?? 0) + 1;
    signatures.set(signature, repeats);
    if (repeats > limits.max_repeated_captures) return forcePartialReceipt(extracted, 'Repeated capture indicates stalled navigation; coverage is incomplete.', inventory);
  }

  return forcePartialReceipt(lastExtracted, 'Collector step limit reached; coverage is incomplete.', inventory);
}
