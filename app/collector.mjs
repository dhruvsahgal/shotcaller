import { assessSegment } from './coverage.mjs';
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

class ObservationTimeout extends Error {}
async function observeWithin(observe, input, startedAt, maxElapsed, now) {
  const remaining = maxElapsed - (now() - startedAt);
  if (remaining <= 0) throw new ObservationTimeout('Collector time limit reached');
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => observe({ ...input, signal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ObservationTimeout('Collector time limit reached')); }, remaining); })
    ]);
  } finally { clearTimeout(timer); }
}

export async function collectBoundedRoster({ request, observe, limits: limitInput, now = () => Date.now() }) {
  if (typeof observe !== 'function') throw new Error('Collector requires an observation function');
  const limits = limitsOf(limitInput);
  const startedAt = now();
  const signatures = new Map();
  const inventory = [];
  let lastExtracted = null;
  let tokens = 0;

  for (let step = 1; step <= limits.max_steps; step += 1) {
    let capture;
    try { capture = await observeWithin(observe, { step, url: request.allowed_pages[0] }, startedAt, limits.max_elapsed_ms, now); }
    catch (error) {
      if (!(error instanceof ObservationTimeout)) throw error;
      if (!lastExtracted) throw new Error('Collector observation timed out before source evidence was captured');
      return forcePartialReceipt(lastExtracted, 'Collector time limit reached; coverage is incomplete.', inventory);
    }
    const extracted = extractRosterObservation(capture, request);
    lastExtracted = extracted;
    inventory.push(extracted.extraction.page_inventory[0]);
    tokens += estimatedTokens(capture);
    if (extracted.status === 'needs_login') return { ...extracted, extraction: { ...extracted.extraction, page_inventory: inventory } };
    if (tokens > limits.max_source_tokens) return forcePartialReceipt(extracted, 'Collector source token limit reached; coverage is incomplete.', inventory);
    if (now() - startedAt > limits.max_elapsed_ms) return forcePartialReceipt(extracted, 'Collector time limit reached; coverage is incomplete.', inventory);
    if (capture.ready !== false) return { ...extracted, extraction: { ...extracted.extraction, page_inventory: inventory } };

    const signature = captureSignature(capture);
    const repeats = (signatures.get(signature) ?? 0) + 1;
    signatures.set(signature, repeats);
    if (repeats > limits.max_repeated_captures) return forcePartialReceipt(extracted, 'Repeated capture indicates stalled navigation; coverage is incomplete.', inventory);
  }

  return forcePartialReceipt(lastExtracted, 'Collector step limit reached; coverage is incomplete.', inventory);
}

/** Full-league adapter seam: each invocation observes only one declared dataset segment. */
export async function collectDatasetSegment({ segment, observe, fragments = [], limits: limitInput, now = () => Date.now() }) {
  if (typeof observe !== 'function') throw new Error('Collector requires an observation function');
  const limits = limitsOf(limitInput), started = now();
  const captured = structuredClone(fragments);
  let assessment = assessSegment(segment, captured);
  if (assessment.status === 'complete' || assessment.resume_page_key === null) return { ...assessment, fragments: captured };
  let tokens = 0;
  for (let step = 0; step < limits.max_steps; step += 1) {
    let fragment;
    try { fragment = await observeWithin(observe, { segment: structuredClone(segment), page_key: assessment.resume_page_key }, started, limits.max_elapsed_ms, now); }
    catch (error) {
      if (!(error instanceof ObservationTimeout)) throw error;
      return { ...assessment, status: 'partial', issues: [...assessment.issues, 'Dataset collection time limit reached'], fragments: captured };
    }
    captured.push(fragment); tokens += estimatedTokens(fragment);
    assessment = assessSegment(segment, captured);
    if (tokens > limits.max_source_tokens || now() - started > limits.max_elapsed_ms) {
      captured[captured.length - 1] = { ...fragment, status: 'partial' };
      return { ...assessSegment(segment, captured), status: 'partial', issues: [...assessment.issues, 'Dataset collection budget exhausted'], fragments: captured };
    }
    if (assessment.status === 'complete' || assessment.resume_page_key === null) return { ...assessment, fragments: captured };
  }
  return { ...assessment, status: 'partial', issues: [...assessment.issues, 'Dataset step limit reached; resume this segment'], fragments: captured };
}
