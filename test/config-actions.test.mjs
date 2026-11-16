import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCredentialIsolation, configuration, rotatedCredentialConfiguration } from '../app/config.mjs';

const appToken = 'app-token-that-is-at-least-24-characters';
const boxesSecret = 'boxes-secret-that-is-at-least-24-characters';
const signingKey = 'signing-key-that-is-at-least-thirty-two-characters';

test('every application, boxes, and signing credential is pairwise isolated', () => {
  assert.throws(() => configuration({ APP_TOKEN: appToken, BOXES_AUTOMATION_SECRET: appToken }), /credential isolation/);
  assert.throws(() => configuration({ APP_TOKEN: appToken, COLLECTOR_RUN_TOKEN: appToken }), /credential isolation/);
  assert.throws(() => configuration({ BOXES_AUTOMATION_SECRET: signingKey, ACTION_SIGNING_KEY: signingKey }), /credential isolation/);
  assert.equal(assertCredentialIsolation({ token: appToken, boxesSecret, actionSigningKey: signingKey }), true);
});

test('credential rotation rejects reuse and preserves isolated unrelated credentials', () => {
  const current = { token: appToken, collectorToken: '', approvalToken: '', executorToken: '', boxesSecret, actionSigningKey: signingKey };
  assert.throws(() => rotatedCredentialConfiguration(current, 'boxesSecret', appToken), /credential isolation/);
  assert.throws(() => rotatedCredentialConfiguration(current, 'boxesSecret', boxesSecret), /credential rotation/);
  const rotated = rotatedCredentialConfiguration(current, 'boxesSecret', 'rotated-boxes-secret-at-least-24-characters');
  assert.notEqual(rotated.boxesSecret, current.boxesSecret);
  assert.equal(rotated.token, current.token);
});

test('action evidence freshness has a bounded configuration', () => {
  assert.equal(configuration({}).actionMaxObservationAgeMs, 120_000);
  assert.equal(configuration({ ACTION_MAX_OBSERVATION_AGE_MS: '60000' }).actionMaxObservationAgeMs, 60_000);
  assert.throws(() => configuration({ ACTION_MAX_OBSERVATION_AGE_MS: '0' }), /observation age/);
  assert.throws(() => configuration({ ACTION_MAX_OBSERVATION_AGE_MS: '3600001' }), /observation age/);
});
