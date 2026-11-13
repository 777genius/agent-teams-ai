import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

const row = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const failures = [
  'native_execution_failed',
  'native_execution_cancelled',
  'provider_free_quota_exhausted',
  'native_owner_retired',
  'native_owner_not_started',
] as const;
const same = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) =>
  a.dev === b.dev && a.ino === b.ino;

/** Read only fixed metadata files under this invocation's disposable TEST root.
 * No auth/profile/plan files, transport requests, prompts or owner startup occur. */
async function read(directory: string, name: 'probe.json' | 'state.json' | 'stop.json') {
  try {
    const parent = await lstat(directory, { bigint: true });
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (await realpath(directory)) !== directory
    )
      return null;
    const file = path.join(directory, name),
      before = await lstat(file, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size > 512n * 1024n ||
      (await realpath(file)) !== file
    )
      return null;
    const held = await open(file, 'r');
    try {
      if (!same(before, await held.stat({ bigint: true }))) return null;
      const bytes = Buffer.alloc(512 * 1024 + 1),
        result = await held.read(bytes);
      const after = await held.stat({ bigint: true });
      if (
        result.bytesRead > 512 * 1024 ||
        !same(before, after) ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        !same(before, await lstat(file, { bigint: true })) ||
        !same(parent, await lstat(directory, { bigint: true }))
      )
        return null;
      return row(JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8')));
    } finally {
      await held.close();
    }
  } catch {
    return null;
  }
}

function binding(value: unknown) {
  const b = row(value);
  if (
    typeof b.teamId !== 'string' ||
    !/^TEST-execution-probe-[a-f0-9]{32}$/.test(b.teamId) ||
    typeof b.runId !== 'string' ||
    b.teamId !== `TEST-execution-probe-${b.runId}` ||
    !/^[a-f0-9]{32}$/.test(b.runId) ||
    !['controllerInstanceId', 'ownerId'].every(
      (key) => typeof b[key] === 'string' && /^[a-f0-9-]{36}$/.test(b[key] as string)
    )
  )
    return null;
  return {
    teamId: b.teamId,
    runId: b.runId,
    controllerInstanceId: b.controllerInstanceId as string,
    ownerId: b.ownerId as string,
  };
}

/** Closed observation only. Probe retirement is not the enclosing team's Stop proof. */
export function projectReadinessProbeReceipt(
  sourceKey: string,
  probeValue: unknown,
  stateValue: unknown,
  stopValue: unknown,
  selectedModel: string
) {
  const probe = row(probeValue),
    state = row(stateValue),
    stop = row(stopValue);
  const b = binding(probe.binding);
  if (
    !/^[a-f0-9]{64}$/.test(sourceKey) ||
    probe.sourceKey !== sourceKey ||
    !b ||
    typeof probe.submitted !== 'boolean' ||
    typeof probe.retired !== 'boolean' ||
    typeof probe.sessionID !== 'string' ||
    !/^ses_[A-Za-z0-9]+$/.test(probe.sessionID) ||
    (probe.proof !== null &&
      (typeof probe.proof !== 'object' || !probe.proof || Array.isArray(probe.proof))) ||
    (probe.failure !== null && !failures.some((value) => value === probe.failure))
  )
    return null;
  const matches = (value: unknown) => {
    const other = binding(value);
    return (
      other !== null &&
      Object.keys(b).every((key) => b[key as keyof typeof b] === other[key as keyof typeof other])
    );
  };
  const failure = failures.find((value) => value === probe.failure) ?? null;
  const members = Array.isArray(state.members) ? state.members : [];
  const member = row(members[0]);
  const boundRunState =
    matches(state.binding) &&
    members.length === 1 &&
    member.memberId === 'probe' &&
    member.originalSessionId === probe.sessionID &&
    member.selectedModel === selectedModel;
  // The SDK can write a terminal no-start probe before creating a run directory.
  // Preserve only its closed failure classification, never a model/run/cleanup proof.
  const noStartWithoutRunState =
    failure === 'native_owner_not_started' &&
    probe.submitted === false &&
    probe.retired === true &&
    probe.proof === null &&
    Object.keys(state).length === 0 &&
    Object.keys(stop).length === 0;
  if (!boundRunState && !noStartWithoutRunState) return null;
  if (
    failure &&
    (probe.proof !== null ||
      (failure === 'native_owner_retired' || failure === 'native_owner_not_started'
        ? probe.submitted !== false || probe.retired !== true
        : probe.submitted !== true))
  )
    return null;
  const receipt = matches(stop.binding) ? row(stop.receipt) : {};
  const stoppedMembers = Array.isArray(receipt.members) ? receipt.members : [];
  const cleanup =
    stoppedMembers.length === 1 && row(stoppedMembers[0]).memberId === 'probe'
      ? row(row(stoppedMembers[0]).cleanup)
      : {};
  const owner = row(probe.ownerFailure),
    operation = row(owner.operation);
  const ownerOperation = [
    'provider-read',
    'model-read',
    'integration-read',
    'activation-await',
    'key-connect',
    'credential-delete',
    'credential-activate',
  ].find((v) => v === operation.operation);
  const ownerStage = ['request', 'response', 'body', 'decode'].find((v) => v === operation.stage);
  return {
    sourceKey,
    scope: 'isolated_TEST_selected_model_readiness_probe_not_team_bootstrap' as const,
    authority: 'observation_only' as const,
    bindingMatched: boundRunState,
    selectedModelMatched: boundRunState,
    submitted: probe.submitted,
    retired: probe.retired,
    proofPresent: probe.proof !== null,
    failure,
    classification:
      failure === 'native_execution_failed'
        ? 'readiness_native_terminal_failed'
        : failure === 'native_execution_cancelled'
          ? 'readiness_native_terminal_cancelled'
          : failure === 'provider_free_quota_exhausted'
            ? 'readiness_provider_free_quota_exhausted'
            : failure
              ? 'readiness_owner_not_submitted'
              : 'readiness_result_without_failure',
    // e13's retired native failure record has no provider error type or HTTP status.
    providerFailure: 'not_preserved_in_probe_record' as const,
    // These statuses belong to the local native provider wire, not a model inference response.
    ownerProviderWire:
      failure === 'native_owner_retired' && ownerOperation && ownerStage
        ? {
            operation: ownerOperation,
            stage: ownerStage,
            httpStatus:
              Number.isInteger(operation.status) &&
              Number(operation.status) >= 100 &&
              Number(operation.status) <= 599
                ? (operation.status as number)
                : null,
          }
        : null,
    runState:
      ['starting', 'active', 'stopping', 'stopped', 'cleanup_unknown'].find(
        (v) => v === state.state
      ) ?? null,
    stopState: ['stopped', 'cleanup_unknown'].find((v) => v === receipt.state) ?? null,
    cleanup: {
      scopeClosed: cleanup.scopeClosed === true,
      processRetired: cleanup.processRetired === true,
      descendantsRetired: cleanup.descendantsRetired === true,
    },
  };
}

export async function readReadinessProbeReceipts(
  testRoot: string,
  dataRoot: string,
  selectedModel: string
) {
  assert(
    path.basename(testRoot).startsWith('TEST-oc-') &&
      dataRoot === path.join(testRoot, 'runtime-data')
  );
  const unavailable = () => ({
    observation: 'unavailable' as const,
    candidates: 0,
    unmatchedOrUnavailable: 0,
    truncated: false,
    receipts: [] as NonNullable<ReturnType<typeof projectReadinessProbeReceipt>>[],
  });
  const result = { ...unavailable(), observation: 'read' as 'read' | 'unavailable' };
  try {
    const root = path.join(dataRoot, 'opencode', 'v2', 'execution-probes');
    // Check every ancestor: a canonical leaf must not authorize traversal through a foreign link.
    for (const directory of [
      testRoot,
      dataRoot,
      path.join(dataRoot, 'opencode'),
      path.join(dataRoot, 'opencode', 'v2'),
      root,
    ]) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory)
        return unavailable();
    }
    const dirs = await opendir(root);
    let visited = 0;
    for await (const entry of dirs) {
      if (++visited > 256) {
        result.truncated = true;
        break;
      }
      if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
      if (result.candidates === 16) {
        result.truncated = true;
        break;
      }
      result.candidates++;
      const probe = await read(path.join(root, entry.name), 'probe.json');
      const b = binding(probe?.binding);
      // SDK canonicalExecutionJSON sorts object keys. These fixed two fields form the run path.
      const runKey =
        b &&
        createHash('sha256')
          .update(JSON.stringify({ runId: b.runId, teamId: b.teamId }))
          .digest('hex')
          .slice(0, 32);
      const runDir = runKey && path.join(dataRoot, 'opencode', 'v2', 'runs', runKey);
      const runsRoot = path.join(dataRoot, 'opencode', 'v2', 'runs');
      const runParent = await lstat(runsRoot).catch(() => null);
      const safeRunParent =
        runParent?.isDirectory() &&
        !runParent.isSymbolicLink() &&
        (await realpath(runsRoot)) === runsRoot;
      const state = runDir && safeRunParent ? await read(runDir, 'state.json') : null;
      const stop = runDir && safeRunParent ? await read(runDir, 'stop.json') : null;
      const projected = projectReadinessProbeReceipt(entry.name, probe, state, stop, selectedModel);
      if (projected) result.receipts.push(projected);
      else result.unmatchedOrUnavailable++;
    }
    return result;
  } catch {
    return unavailable();
  }
}
