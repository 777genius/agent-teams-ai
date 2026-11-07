// TEST-only native Host evidence gate; a package-lock is not an E2E receipt.
// This verifies the recorded TEST proof, not model/tool or production qualification.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_NATIVE_HOST_STEPS = Object.freeze([
  "pinned_actual_ELF_measured",
  "actual_native_PID_start_and_digest",
  "native_loopback_authenticated_identity",
  "native_loopback_unauthenticated_request_rejected",
  "native_TEST_session_created_no_model_call",
  "native_TEST_session_workspace_and_permissions_attested",
  "real_native_later_allow_preflight_hold",
  "real_native_later_allow_resolver_observed_preflight_hold",
  "real_native_ordered_ask_readback_without_tool_execution",
  "real_native_ask_permission_rejected_without_tool_execution",
  "actual_native_instruction_put_and_readback",
  "Host_existing_Session_SPI_ready_with_real_native_attestation",
  "Host_remeasured_real_ELF_digest_PID_and_start_identity_on_recheck",
  "Host_native_readiness_recheck_no_instruction_replay",
  "Host_live_foreign_native_permission_stale_no_grant",
  "real_native_Host_captured_external_deny_resolver_observed",
  "real_native_fresh_session_durable_log_cursor_read_only",
  "Host_seal_started_real_native_owned_stop_before_close",
  "real_native_seal_refused_retained_SPI_mutations_and_checkpoint",
  "same_TEST_native_owner_closed_without_replay",
  "native_cold_restart_session_permissions_and_context_read_only",
  "native_cold_restart_durable_log_cursor_read_only",
  "same_TEST_native_owner_restart_cleanup_confirmed"
]);
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sourceSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const pid = value => Number.isSafeInteger(value) && value > 0;
const ticks = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);

export function isCompleteNativeHostReceipt(value, expectedSourceHead) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (expectedSourceHead !== undefined &&
        (!sourceSha(expectedSourceHead) || value.sourceHead !== expectedSourceHead))) return false;
  const r = value, restarted = r.restart, log = r.nativeLogReadback;
  const recovered = r.restartLogReadback, policy = r.nativePolicyDecisions;
  return r.kind === 'TEST_NATIVE_HOST_SPI_INSTRUCTIONS' && r.version === '2.0.21' &&
    r.cleanup === true && r.error === undefined && r.cleanupError === undefined &&
    r.qualified === false && r.productQualified === false &&
    r.packagedElectronQualified === false && sourceSha(r.sourceHead) &&
    sha256(r.binarySha256) && pid(r.pid) && ticks(r.processStartTicks) &&
    r.nativeCustodyReadbacks === 4 && r.nativePermissionReadbacks === 4 &&
    policy !== undefined && policy !== null && typeof policy === 'object' && !Array.isArray(policy) &&
    policy.capturedDeny === 'deny' && policy.laterAllow === 'allow' &&
    policy.laterAsk === 'ask' && policy.askRejected === true &&
    policy.pendingAfterReject === 0 &&
    policy.resolverOnly === true && policy.toolEnforcementProven === false &&
    r.crossSessionPermission !== undefined && r.crossSessionPermission !== null &&
    typeof r.crossSessionPermission === 'object' && !Array.isArray(r.crossSessionPermission) &&
    r.crossSessionPermission.hostRefused === true &&
    r.crossSessionPermission.foreignPendingUnchanged === true &&
    r.crossSessionPermission.owningSessionRejected === true &&
    r.crossSessionPermission.toolEnforcementProven === false &&
    log !== undefined && log !== null && typeof log === 'object' && !Array.isArray(log) &&
    log.readOnly === true && log.synced === true &&
    Number.isSafeInteger(log.watermark) && log.watermark >= 0 &&
    Number.isSafeInteger(log.eventCount) && log.eventCount >= 0 &&
    log.eventCount <= 4096 && log.modelTurnProven === false &&
    recovered !== undefined && recovered !== null &&
    typeof recovered === 'object' && !Array.isArray(recovered) &&
    recovered.readOnly === true && recovered.synced === true &&
    Number.isSafeInteger(recovered.watermark) && recovered.watermark >= log.watermark &&
    Number.isSafeInteger(recovered.eventCount) && recovered.eventCount >= log.eventCount &&
    recovered.eventCount <= 4096 && recovered.modelTurnProven === false &&
    Array.isArray(r.steps) && r.steps.length === REQUIRED_NATIVE_HOST_STEPS.length &&
    r.steps.every((step, index) => step === REQUIRED_NATIVE_HOST_STEPS[index]) &&
    restarted && typeof restarted === 'object' && !Array.isArray(restarted) &&
    restarted.readOnly === true && restarted.priorPid === r.pid &&
    restarted.priorStartTicks === r.processStartTicks &&
    pid(restarted.pid) && ticks(restarted.startTicks) &&
    (restarted.pid !== r.pid || restarted.startTicks !== r.processStartTicks) &&
    restarted.actualBinarySha256 === r.binarySha256;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let verified = false;
  try {
    const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD;
    if (sourceSha(sourceHead))
      verified = isCompleteNativeHostReceipt(JSON.parse(readFileSync(process.argv[2], 'utf8')),
        sourceHead);
  }
  catch { /* Do not log receipt contents, paths or credentials. */ }
  if (!verified) {
    process.stderr.write('native_host_receipt_missing_or_incomplete\n');
    process.exitCode = 1;
  }
}
