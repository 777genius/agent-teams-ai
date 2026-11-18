import assert from 'node:assert/strict';

type NodeEnvironment = Record<string, string | undefined>;

/** Fixed optional app resource budget for admitted finite Linux proofs, never ambient Node flags. */
export function desktopFiniteHeapNodeOptions(
  environment: Readonly<NodeEnvironment> = process.env,
  platform: string = process.platform,
  arch: string = process.arch
): '--max-old-space-size=1536' | '--max-old-space-size=1024' | undefined {
  const selected = environment.LEGACY_DESKTOP_TEST_FINITE_HEAP_1536;
  const selected1024 = environment.LEGACY_DESKTOP_TEST_FINITE_HEAP_1024;
  if (selected === undefined && selected1024 === undefined) return undefined;
  assert.ok(selected === undefined || selected1024 === undefined, 'finite TEST heap requires exactly one selector');
  assert.equal(selected ?? selected1024, '1', 'finite TEST heap requires its exact selector');
  assert.equal(platform, 'linux', 'finite TEST heap requires Linux');
  assert.equal(arch, 'x64', 'finite TEST heap requires x64');
  assert.equal(environment.LEGACY_DESKTOP_BACKEND_GO, '1', 'finite TEST heap requires explicit launch admission');
  const mode = environment.LEGACY_DESKTOP_PROOF_MODE;
  if (mode === 'opencode-v2-management-ui' || mode === 'native-mixed-create-launch-ui') {
    assert.equal(selected1024, undefined, '1024 MiB finite TEST heap requires an emulated UI mode');
    assert.equal(environment.LEGACY_DESKTOP_EMULATED_ONLY, undefined,
      'finite TEST heap requires the original native V2 scope');
    if (mode === 'native-mixed-create-launch-ui') {
      assert.equal(environment.LEGACY_DESKTOP_MIXED_MEMBERSHIP_UI, '1',
        'finite TEST heap requires the original membership journey');
      assert.equal(environment.LEGACY_DESKTOP_OPENCODE_GENERATION, 'v2',
        'finite TEST heap requires OpenCode V2 membership');
      assert.equal(environment.LEGACY_DESKTOP_FINITE_V2_MEMBERSHIP, '1',
        'finite TEST heap requires finite initial membership peers');
    }
  } else {
    assert.equal(environment.LEGACY_DESKTOP_EMULATED_ONLY, '1', 'finite TEST heap requires provider emulation');
    assert.ok([
      'emulated-retained-original-ui', 'emulated-import-lifecycle-ui', 'task-board-cross-team-ui',
      'emulated-selection-ui', 'emulated-import-ui', 'emulated-claude-lifecycle-ui', 'emulated-collaboration-ui',
    ].includes(mode ?? ''),
      'finite TEST heap requires an exact finite UI mode');
  }
  if (environment.AGENT_TEAMS_DISABLE_SOURCEMAPS !== undefined)
    assert.equal(environment.AGENT_TEAMS_DISABLE_SOURCEMAPS, '1', 'finite TEST source maps require their exact selector');
  return selected1024 === undefined ? '--max-old-space-size=1536' : '--max-old-space-size=1024';
}

/** Carry only the validated finite context through the closed original app environment. */
export function desktopFiniteHeapAppEnvironment(
  environment: Readonly<NodeEnvironment> = process.env
): Record<string, string> {
  const options = desktopFiniteHeapNodeOptions(environment);
  return options === undefined ? {} : {
    NODE_OPTIONS: options,
    ...(options === '--max-old-space-size=1024'
      ? { LEGACY_DESKTOP_TEST_FINITE_HEAP_1024: '1', UV_THREADPOOL_SIZE: '4' }
      : { LEGACY_DESKTOP_TEST_FINITE_HEAP_1536: '1' }),
    LEGACY_DESKTOP_BACKEND_GO: '1',
    LEGACY_DESKTOP_PROOF_MODE: environment.LEGACY_DESKTOP_PROOF_MODE!,
    ...(environment.AGENT_TEAMS_DISABLE_SOURCEMAPS === '1' ? { AGENT_TEAMS_DISABLE_SOURCEMAPS: '1' } : {}),
    ...(environment.LEGACY_DESKTOP_EMULATED_ONLY === '1' ? { LEGACY_DESKTOP_EMULATED_ONLY: '1' } : {}),
    ...(environment.LEGACY_DESKTOP_PROOF_MODE === 'native-mixed-create-launch-ui' ? {
      LEGACY_DESKTOP_MIXED_MEMBERSHIP_UI: '1',
      LEGACY_DESKTOP_OPENCODE_GENERATION: 'v2',
      LEGACY_DESKTOP_FINITE_V2_MEMBERSHIP: '1',
    } : {}),
  };
}

/** The original dev entrypoint supplies its unchanged normalizer at this boundary. */
export function normalizeDesktopDevNodeOptions(
  environment: NodeEnvironment,
  normalize: (environment: NodeEnvironment, minimumMb?: number) => void,
  platform: string = process.platform,
  arch: string = process.arch
): void {
  const finite = desktopFiniteHeapNodeOptions(environment, platform, arch);
  if (finite !== undefined)
    assert.equal(environment.NODE_OPTIONS, finite, 'finite TEST startup requires only its exact Node option');
  if (finite === '--max-old-space-size=1024')
    assert.equal(environment.UV_THREADPOOL_SIZE, '4', '1024 MiB finite TEST startup requires its fixed worker pool');
  normalize(environment, finite === undefined ? undefined : finite === '--max-old-space-size=1024' ? 1024 : 1536);
  if (finite !== undefined)
    assert.equal(environment.NODE_OPTIONS, finite, 'finite TEST startup must retain its fixed Node option');
  if (finite === '--max-old-space-size=1024')
    assert.equal(environment.UV_THREADPOOL_SIZE, '4', '1024 MiB finite TEST startup must retain its fixed worker pool');
}
