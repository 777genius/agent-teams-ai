/**
 * Resolves the exact OpenCode CLI pins for the native Windows real-task gate.
 *
 * V2 pins come from the selected runtime's own registry. The main target is the
 * newest V2 release the registry knows on any platform; a runtime that does not
 * yet qualify it for Windows x64 is refused here, so qualifying it means running
 * this gate on a candidate whose registry adds win32-x64. The fixed floor-wire
 * release is a separate short compatibility pin. V1 has no runtime registry;
 * its exact TEST pin lives only here.
 *
 * The runtime's published release contract is printed too, so a staged
 * candidate pins it in runtime.lock.json the same way a real runtime pin does.
 *
 * Usage: bun scripts/e2e/opencode-native-windows-pins.ts <sdk-root> <all|v1|v2|current>
 * Prints `key=value` lines for GITHUB_OUTPUT.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { readOpenCodeV2Contract } from '../../src/features/opencode-compatibility/core/domain/openCodeV2Contract.ts';

const PLATFORM = 'win32-x64';
const V1_PIN = '1.19.0';

assert(process.argv.length === 4, 'Usage: opencode-native-windows-pins.ts <sdk-root> <versions>');
const versions = process.argv[3]!;
assert(['all', 'v1', 'v2', 'current'].includes(versions), 'Unknown Windows version selection');
const lines = [`v1=${V1_PIN}`];
if (versions !== 'v1') {
  const sdk = await realpath(path.resolve(process.argv[2]!));
  const registryPath = path.join(sdk, 'src/services/opencode/compatibility/OpenCodeV2Registry.ts');
  const present = await lstat(registryPath).then((stat) => stat.isFile(), () => false);
  assert(present, 'Selected runtime predates the OpenCode V2 registry; dispatch from a matching app ref');
  const registry = (await import(pathToFileURL(registryPath).href)) as Record<string, unknown>;
  const floor = registry.OPENCODE_V2_FLOOR_WIRE_VERSION;
  const releaseContract = registry.openCodeV2ReleaseContract;
  const wire = registry.openCodeV2Wire;
  const known = registry.openCodeV2QualifiedVersions;
  assert(
    typeof floor === 'string' && typeof releaseContract === 'function' && typeof wire === 'function' &&
      typeof known === 'function',
    'Selected runtime has no OpenCode V2 registry contract'
  );
  const contract: unknown = releaseContract();
  // The packaged app parses the pinned contract with this exact reader; reject it before packaging.
  assert(readOpenCodeV2Contract(contract) !== null, 'Selected runtime V2 contract is not a valid app contract');
  const qualified: unknown = (contract as { qualified?: Record<string, unknown> }).qualified?.[PLATFORM];
  assert(
    Array.isArray(qualified) && qualified.every((version) => typeof version === 'string'),
    `Selected runtime publishes no ${PLATFORM} V2 qualification list`
  );
  // The registry sorts every recorded release ascending; the newest is the main target.
  const recorded: unknown = known();
  const current: unknown = Array.isArray(recorded) ? recorded.at(-1) : undefined;
  assert(
    typeof current === 'string' && wire(current) === 'current',
    'Selected runtime records no current-wire V2 release'
  );
  assert(
    qualified.includes(current),
    `Newest OpenCode V2 ${current} is not qualified for ${PLATFORM} by the selected runtime; ` +
      `qualify it with a candidate runtime whose registry adds ${PLATFORM}`
  );
  // Current-only runs never install or start the floor release.
  assert(
    versions === 'current' || qualified.includes(floor),
    `Selected runtime does not qualify the V2 floor ${floor} on ${PLATFORM}`
  );
  lines.push(`floor=${floor}`, `current=${current}`, `contract=${JSON.stringify(contract)}`);
}
for (const line of lines)
  assert(/^(?:(?:v1|floor|current)=\d+\.\d+\.\d+|contract=\{[^\n]*\})$/.test(line), 'Resolved pin invalid');
console.log(lines.join('\n'));
