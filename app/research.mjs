import { strictInstant } from './time.mjs';

const states = new Set(['available', 'questionable', 'doubtful', 'out', 'suspended', 'unknown']);

export function participationScenarios(observation) {
  const status = states.has(observation?.status) ? observation.status : 'unknown';
  const sourced = Boolean(observation && strictInstant(observation.observed_at) && Array.isArray(observation.source_ids) && observation.source_ids.length);
  if (!sourced) return { lower: false, upper: true, status: 'unknown', sourced: false };
  if (status === 'unknown') return { lower: false, upper: true, status, sourced: true };
  if (status === 'available') return { lower: true, upper: true, status, sourced: true };
  if (status === 'out' || status === 'suspended') return { lower: false, upper: false, status, sourced: true };
  return { lower: false, upper: true, status, sourced: true };
}
