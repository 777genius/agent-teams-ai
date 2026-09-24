import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyComposeFailure } from './run.mjs';

test('later Product startup diagnostic survives verbose Compose build output', () => {
  const composeBuild = 'building image\n'.repeat(50_000);
  const productLog = 'hosted-state-startup-refused:state_metadata_invalid\n';
  assert.ok(composeBuild.length > 512 * 1024);
  assert.equal(classifyComposeFailure([composeBuild, productLog]),
    'hosted-state-metadata-invalid');
});
