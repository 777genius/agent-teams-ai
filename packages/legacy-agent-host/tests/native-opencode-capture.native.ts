import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runNativeInputCapture } from './fixtures/native-input-capture.ts';
import {
  opencodeCaptureFixture,
  opencodeFailedShellCaptureFixture,
} from './fixtures/native-opencode-team/capture.ts';

const normalGo = process.env.LEGACY_NATIVE_OPENCODE_CAPTURE_GO === '1';
const failedGo = process.env.LEGACY_NATIVE_OPENCODE_FAILED_CAPTURE_GO === '1';
assert.ok(!(normalGo && failedGo), 'select one explicit native capture scenario before any effect');

test(
  'actual Host TaskStart -> native OpenCode1.19.4 read/edit -> qualified dirty ledger -> cold controlled review',
  { timeout: 180_000, skip: failedGo && !normalGo },
  (t) => runNativeInputCapture(t, opencodeCaptureFixture)
);

test(
  'actual Host TaskStart -> native opencode exit7 -> successful same input -> partial nonreviewable dirty evidence',
  { timeout: 300_000, skip: normalGo && !failedGo },
  (t) => runNativeInputCapture(t, opencodeFailedShellCaptureFixture)
);
