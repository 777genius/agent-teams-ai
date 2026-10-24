import { test } from 'node:test';
import { runNativeInputCapture } from './fixtures/native-input-capture.ts';
import { opencodeCaptureFixture } from './fixtures/native-opencode-team/capture.ts';

test(
  'actual Host TaskStart -> native OpenCode1.19.4 read/edit -> qualified dirty ledger -> cold controlled review',
  { timeout: 180_000 },
  (t) => runNativeInputCapture(t, opencodeCaptureFixture)
);
