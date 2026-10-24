import { test } from 'node:test';
import { runNativeInputCapture } from './fixtures/native-input-capture.ts';
import { codexCaptureFixture } from './fixtures/native-codex-team/capture.ts';

test(
  'actual Host TaskStart -> native Codex read/update -> qualified dirty ledger -> cold controlled review',
  { timeout: 180_000 },
  (t) => runNativeInputCapture(t, codexCaptureFixture)
);
