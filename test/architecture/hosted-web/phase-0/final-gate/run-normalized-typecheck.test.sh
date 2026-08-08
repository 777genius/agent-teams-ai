#!/usr/bin/env bash

set -eu

runner='scripts/hosted-web/phase-0/final-gate/run-normalized-typecheck.sh'
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/phase-0-final-gate-shell-test.XXXXXX")"
trap 'rm -rf "$temporary_directory"' EXIT

assert_scenario() {
  scenario="$1"
  expected_signal="$2"
  report="$temporary_directory/$scenario.json"

  set +e
  PHASE0_FINAL_GATE_TESTING=1 PHASE0_TYPECHECK_TIMEOUT_MS=100 \
    bash "$runner" test-stage "$scenario" >"$report"
  runner_status=$?
  set -e

  if [ "$runner_status" -ne 1 ]; then
    printf '%s scenario returned %s instead of fail-closed status 1\n' \
      "$scenario" "$runner_status" >&2
    exit 1
  fi

  node - "$report" "$scenario" "$expected_signal" <<'NODE'
const fs = require('node:fs');
const [reportPath, expectedDisposition, expectedSignal] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const signal = expectedSignal === 'null' ? null : expectedSignal;
if (
  report.passed !== false ||
  report.processDisposition !== expectedDisposition ||
  report.signal !== signal
) {
  process.stderr.write(`${expectedDisposition} disposition did not fail closed:\n`);
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(1);
}
NODE
}

assert_scenario timeout SIGTERM
assert_scenario signal SIGTERM
assert_scenario runner-error null

printf 'production runner disposition tests passed: timeout, signal, runner-error\n'
