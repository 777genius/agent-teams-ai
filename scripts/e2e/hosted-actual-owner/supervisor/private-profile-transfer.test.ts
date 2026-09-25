import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { canonicalJson, sha256 } from './canonical';
import { AUTH_DOCUMENT_MAXIMUM, maximumAuthFrame, privateProfileBytes, PROFILE_BINDING, PROFILE_MAXIMUM,
  SERVER_AUTH_V1, SERVER_AUTH_V2, validatePreparedProfileTransfer,
  type PreparedProfileContext, type PreparedProfileTransfer } from './private-profile-transfer';

const key = Buffer.alloc(32, 27);
const context: PreparedProfileContext = { expectedHostSha256: '1'.repeat(64),
  ownerProcessStartToken: '2'.repeat(64), bootstrapDigest: '3'.repeat(64) };
// Wire-only fixture. This does not replace the real-preparer integration gate.
function transfer(projection: unknown, bindingContext = context): PreparedProfileTransfer {
  const bytes = privateProfileBytes(projection, PROFILE_MAXIMUM), publicationId = '4'.repeat(64);
  try {
    const digest = sha256(bytes);
    return { preparedProfile: projection, preparedProfileSha256: digest, publicationId,
      binding: { format: PROFILE_BINDING, publicationId, byteLength: bytes.length,
        hmacSha256: createHmac('sha256', key).update(PROFILE_BINDING + '\0').update(canonicalJson({
          publicationId, profileSha256: digest, ...bindingContext,
        })).digest('hex') } };
  } finally { bytes.fill(0); }
}
test('private finite configuration numbers use Owner canonical bytes; v1 retains its bound', () => {
  const bytes = privateProfileBytes({ temperature: 0.25, nested: { token: 'sentinel-secret' } }, 1000);
  assert.equal(bytes.toString(), '{"nested":{"token":"sentinel-secret"},"temperature":0.25}');
  bytes.fill(0);
  assert.equal(maximumAuthFrame(SERVER_AUTH_V1), 8196);
  assert.equal(maximumAuthFrame(SERVER_AUTH_V2), AUTH_DOCUMENT_MAXIMUM + 4);
  assert.throws(() => maximumAuthFrame('agent-teams.hosted-control.opencode-server-auth/v3' as typeof SERVER_AUTH_V2));
  for (const value of [NaN, Infinity, -0, undefined, '\ud800', new Array(2)]) {
    assert.throws(() => privateProfileBytes({ value }, 1000));
  }
});
test('exact profile byte ceiling rejects overflow without truncation', () => {
  const exact = privateProfileBytes({ p: 'x'.repeat(PROFILE_MAXIMUM - 8) }, PROFILE_MAXIMUM);
  assert.equal(exact.length, PROFILE_MAXIMUM); exact.fill(0);
  assert.throws(() => privateProfileBytes({ p: 'x'.repeat(PROFILE_MAXIMUM - 7) }, PROFILE_MAXIMUM));
});
test('nested URL/environment changes reject even when normalized fingerprints collide', () => {
  const sentinels = { managedConfigFingerprint: 'a'.repeat(64), managedConfigJson:
    JSON.stringify({ mcp: { app: { url: 'https://sentinel-user:sentinel-token@localhost',
      environment: { NESTED: 'sentinel-secret' }, command: ['node', '--token=sentinel-arg'] } } }) };
  const original = transfer(sentinels);
  const binding = validatePreparedProfileTransfer(original, key, context);
  const publicBytes = JSON.stringify(binding);
  for (const text of ['sentinel-token', 'sentinel-secret', 'sentinel-arg', original.preparedProfileSha256,
    Buffer.from(sentinels.managedConfigJson).toString('base64')]) assert(!publicBytes.includes(text));
  assert.throws(() => validatePreparedProfileTransfer({ ...original,
    preparedProfile: { ...sentinels, managedConfigJson: sentinels.managedConfigJson.replace('sentinel-token', 'different-token') } }, key, context));
});
test('four generations reuse publication identity with distinct exact start/context commitments', () => {
  const macs = new Set<string>();
  for (let generation = 1; generation <= 4; generation++) {
    const next = { ...context, expectedHostSha256: String(generation + 3).repeat(64),
      ownerProcessStartToken: String(generation + 4).repeat(64) };
    const publication = transfer({ managedConfigJson: '{"token":"private"}' }, next);
    macs.add(validatePreparedProfileTransfer(publication, key, next).hmacSha256);
    assert.equal(publication.publicationId, '4'.repeat(64));
    assert.throws(() => validatePreparedProfileTransfer(publication, key, context));
  }
  assert.equal(macs.size, 4);
});
test('binding, key, length and bootstrap substitutions reject', () => {
  const original = transfer({ managedConfigJson: '{}' });
  for (const changed of [
    { ...original, binding: { ...original.binding, byteLength: original.binding.byteLength + 1 } },
    { ...original, preparedProfileSha256: '0'.repeat(64) },
    { ...original, publicationId: '5'.repeat(64) },
  ]) assert.throws(() => validatePreparedProfileTransfer(changed, key, context));
  assert.throws(() => validatePreparedProfileTransfer(original, Buffer.alloc(32, 28), context));
  assert.throws(() => validatePreparedProfileTransfer(original, key, { ...context, bootstrapDigest: '6'.repeat(64) }));
});
