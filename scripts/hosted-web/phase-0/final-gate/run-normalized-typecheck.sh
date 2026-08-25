#!/usr/bin/env bash

set -u

mode="${1:-targeted}"
normalizer_mode="$mode"
case "$mode" in
  targeted | milestone) ;;
  test-stage)
    if [ "${PHASE0_FINAL_GATE_TESTING:-}" != '1' ]; then
      printf 'test-stage requires PHASE0_FINAL_GATE_TESTING=1\n' >&2
      exit 64
    fi
    normalizer_mode='targeted'
    ;;
  *)
    printf 'unsupported mode %s\n' "$mode" >&2
    exit 64
    ;;
esac

timeout_ms="${PHASE0_TYPECHECK_TIMEOUT_MS:-300000}"
if ! [[ "$timeout_ms" =~ ^[1-9][0-9]*$ ]]; then
  printf 'PHASE0_TYPECHECK_TIMEOUT_MS must be a positive integer\n' >&2
  exit 64
fi
timeout_seconds=$(((timeout_ms + 999) / 1000))
normalizer='scripts/hosted-web/phase-0/final-gate/normalize-typescript-diagnostics.mjs'
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/phase-0-final-gate.XXXXXX")"
trap 'rm -rf "$temporary_directory"' EXIT

run_stage() {
  stage_id="$1"
  output_file="$2"
  report_file="$3"
  shift 3
  compiler_command="$*"
  control_file="$temporary_directory/$stage_id.control"
  started_ns="$(date +%s%N)"
  timeout --verbose --signal=TERM --kill-after=5s "${timeout_seconds}s" \
    bash -c 'output_file="$1"; shift; exec "$@" >"$output_file" 2>&1' \
    phase-0-final-gate "$output_file" "$@" 2>"$control_file"
  stage_exit=$?
  node - "$output_file" <<'NODE'
const fs = require('node:fs');
const outputPath = process.argv[2];
const repositoryRoot = process.cwd().replaceAll('\\', '/').replace(/\/$/, '');
const output = fs.readFileSync(outputPath, 'utf8').replaceAll('\\', '/');
fs.writeFileSync(outputPath, output.replaceAll(repositoryRoot, '<repo>'));
NODE
  capture_normalization_exit=$?
  if [ "$capture_normalization_exit" -ne 0 ]; then
    printf 'evidence path normalization failed with exit %s\n' \
      "$capture_normalization_exit" >>"$control_file"
    stage_exit=125
  fi
  finished_ns="$(date +%s%N)"
  duration_ms=$(((finished_ns - started_ns) / 1000000))

  process_disposition='exited'
  raw_exit_code="$stage_exit"
  signal='null'
  if grep -q '^timeout: sending signal ' "$control_file"; then
    process_disposition='timeout'
    raw_exit_code='null'
    signal="SIG$(awk '/^timeout: sending signal / { final_signal=$4 } END { print final_signal }' "$control_file")"
  elif [ "$stage_exit" -gt 128 ]; then
    process_disposition='signal'
    raw_exit_code='null'
    signal="SIG$(kill -l "$((stage_exit - 128))")"
  elif [ "$stage_exit" -ge 125 ]; then
    process_disposition='runner-error'
  fi

  node "$normalizer" \
    --mode "$normalizer_mode" \
    --stage-id "$stage_id" \
    --input "$output_file" \
    --exit-code "$raw_exit_code" \
    --duration-ms "$duration_ms" \
    --process-disposition "$process_disposition" \
    --signal "$signal" \
    --timeout-ms "$timeout_ms" \
    --compiler-command "$compiler_command" \
    --raw-capture-path "$output_file" >"$report_file"
}

if [ "$mode" = 'test-stage' ]; then
  scenario="${2:-}"
  fixture_output="$temporary_directory/$scenario.raw.txt"
  fixture_report="$temporary_directory/$scenario.report.json"
  case "$scenario" in
    timeout)
      run_stage root "$fixture_output" "$fixture_report" bash -c 'sleep 5'
      ;;
    signal)
      run_stage root "$fixture_output" "$fixture_report" bash -c 'kill -TERM $$'
      ;;
    runner-error)
      run_stage root "$fixture_output" "$fixture_report" phase0-final-gate-command-does-not-exist
      ;;
    *)
      printf 'unsupported test-stage scenario %s\n' "$scenario" >&2
      exit 64
      ;;
  esac
  cat "$fixture_report"
  node -e 'process.exit(JSON.parse(require("node:fs").readFileSync(process.argv[1])).passed ? 0 : 1)' \
    "$fixture_report"
  exit $?
fi

if [ "$mode" = 'targeted' ]; then
  targeted_output="$temporary_directory/targeted.raw.txt"
  targeted_report="$temporary_directory/targeted.report.json"
  run_stage root "$targeted_output" "$targeted_report" \
    node node_modules/typescript/bin/tsc --noEmit --pretty false \
    --project scripts/hosted-web/phase-0/final-gate/tsconfig.targeted.json
  cat "$targeted_report"
  node -e 'process.exit(JSON.parse(require("node:fs").readFileSync(process.argv[1])).passed ? 0 : 1)' \
    "$targeted_report"
  exit $?
fi

root_output='docs/research/hosted-web/phase-0/final-gate/milestone-typecheck.raw.txt'
mcp_source_output='docs/research/hosted-web/phase-0/final-gate/milestone-typecheck-mcp-source.raw.txt'
mcp_tests_output='docs/research/hosted-web/phase-0/final-gate/milestone-typecheck-mcp-tests.raw.txt'
root_report="$temporary_directory/root.report.json"
mcp_source_report="$temporary_directory/mcp-source.report.json"
mcp_tests_report="$temporary_directory/mcp-tests.report.json"

run_stage root "$root_output" "$root_report" pnpm --silent typecheck
run_stage mcp-source "$mcp_source_output" "$mcp_source_report" \
  pnpm --silent --filter agent-teams-mcp typecheck
run_stage mcp-tests "$mcp_tests_output" "$mcp_tests_report" \
  pnpm --silent --filter agent-teams-mcp typecheck:test

node "$normalizer" --mode milestone --assemble-workspace \
  "$root_report" "$mcp_source_report" "$mcp_tests_report" | \
  tee docs/research/hosted-web/phase-0/final-gate/milestone-typecheck-report.json
exit "${PIPESTATUS[0]}"
