import assert from 'node:assert/strict';

type NodeEnvironment = Record<string, string | undefined>;

/** Fixed optional build budget for two isolated finite Linux proofs, never ambient Node flags. */
export function desktopFiniteHeapNodeOptions(
  environment: Readonly<NodeEnvironment> = process.env,
  platform: string = process.platform,
  arch: string = process.arch
): '--max-old-space-size=1536' | undefined {
  const selected = environment.LEGACY_DESKTOP_TEST_FINITE_HEAP_1536;
  if (selected === undefined) return undefined;
  assert.equal(selected, '1', 'finite TEST heap requires its exact selector');
  assert.equal(platform, 'linux', 'finite TEST heap requires Linux');
  assert.equal(arch, 'x64', 'finite TEST heap requires x64');
  assert.equal(environment.LEGACY_DESKTOP_BACKEND_GO, '1', 'finite TEST heap requires explicit launch admission');
  assert.equal(environment.LEGACY_DESKTOP_EMULATED_ONLY, '1', 'finite TEST heap requires provider emulation');
  assert.ok(['emulated-retained-original-ui', 'emulated-import-lifecycle-ui'].includes(
    environment.LEGACY_DESKTOP_PROOF_MODE ?? ''), 'finite TEST heap requires an exact finite lifecycle mode');
  return '--max-old-space-size=1536';
}

/** Carry only the validated finite context through the closed original app environment. */
export function desktopFiniteHeapAppEnvironment(
  environment: Readonly<NodeEnvironment> = process.env
): Record<string, string> {
  const options = desktopFiniteHeapNodeOptions(environment);
  return options === undefined ? {} : {
    NODE_OPTIONS: options,
    LEGACY_DESKTOP_TEST_FINITE_HEAP_1536: '1',
    LEGACY_DESKTOP_BACKEND_GO: '1',
    LEGACY_DESKTOP_EMULATED_ONLY: '1',
    LEGACY_DESKTOP_PROOF_MODE: environment.LEGACY_DESKTOP_PROOF_MODE!,
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
  normalize(environment, finite === undefined ? undefined : 1536);
  if (finite !== undefined)
    assert.equal(environment.NODE_OPTIONS, finite, 'finite TEST startup must retain its fixed Node option');
}
