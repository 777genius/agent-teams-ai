/**
 * Resolves the exact OpenCode CLI pins for the native Windows real-task gate.
 *
 * V2 pins come from the selected runtime's own registry, so the gate exercises
 * exactly what that runtime admits for team launch on Windows x64: the fixed
 * floor-wire release and the newest qualified release. V1 has no runtime
 * registry; its exact TEST pin lives only here.
 *
 * Usage: bun scripts/e2e/opencode-native-windows-pins.ts <sdk-root> <all|v1|v2|current>
 * Prints `key=value` lines for GITHUB_OUTPUT.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

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
  const registry =(await import(pathToFileURL(registryPath).href)) as Record<string, unknown>;
  const floor = registry.OPENCODE_V2_FLOOR_WIRE_VERSION;
  const contract = registry.openCodeV2ReleaseContract;
  const wire = registry.openCodeV2Wire;
  assert(
    typeof floor === 'string' && typeof contract === 'function' && typeof wire === 'function',
    'Selected runtime has no OpenCode V2 registry contract'
  );
  const qualified: unknown = (contract() as { qualified?: Record<string, unknown> }).qualified?.[PLATFORM];
  assert(
    Array.isArray(qualified) && qualified.every((version) => typeof version === 'string'),
    `Selected runtime publishes no ${PLATFORM} V2 qualification list`
  );
  // The registry sorts qualified releases ascending; the newest is the current target.
  const current: unknown = qualified.at(-1);
  assert(qualified.includes(floor), `Selected runtime does not qualify the V2 floor ${floor} on ${PLATFORM}`);
  assert(
    typeof current === 'string' && wire(current) === 'current',
    `Selected runtime qualifies no current-wire V2 release on ${PLATFORM}`
  );
  lines.push(`floor=${floor}`, `current=${current}`);
}
for (const line of lines) assert(/^(?:v1|floor|current)=\d+\.\d+\.\d+$/.test(line), 'Resolved pin invalid');
console.log(lines.join('\n'));
