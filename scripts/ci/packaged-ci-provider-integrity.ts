import { createHash, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELECTED = [
  '@agent-teams/provider-implementations',
  '@agent-teams/provider-session-contracts',
] as const;

/** Reject stale cached installations if a selected local tarball changed without its lock. */
export function verifySelectedProviderArchives(root: string): void {
  const lock = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8');
  // A correctly hashed, unused lock entry must not certify a different
  // archive selected by the actual Host package importer.
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'packages/legacy-agent-host/package.json'), 'utf8')
  ) as { dependencies?: Record<string, unknown> };
  const lines = lock.split(/\r?\n/);
  const importerName = '  packages/legacy-agent-host:';
  const importerPositions = lines.flatMap((line, index) => line === importerName ? [index] : []);
  if (importerPositions.length !== 1) throw new Error('Missing or ambiguous Host lock importer');
  const nextImporter = lines.findIndex((line, index) =>
    index > importerPositions[0]! && /^  \S.*:$/.test(line));
  const importerLines = lines.slice(importerPositions[0]! + 1,
    nextImporter < 0 ? undefined : nextImporter);
  const dependenciesStart = importerLines.indexOf('    dependencies:');
  if (dependenciesStart < 0) throw new Error('Missing Host lock dependencies');
  const dependenciesEnd = importerLines.findIndex((line, index) =>
    index > dependenciesStart && /^    \S/.test(line));
  const dependencyBlock = importerLines.slice(dependenciesStart + 1,
    dependenciesEnd < 0 ? undefined : dependenciesEnd).join('\n');
  // A redirect of vendor/ or provider-migration/ can make an archive outside
  // the checked-in vendor tree appear valid even with a matching locked hash.
  // Only the caller's trusted repository root may be canonicalized elsewhere.
  const vendorPath = resolve(root, 'vendor');
  const providerPath = resolve(vendorPath, 'provider-migration');
  if (!lstatSync(vendorPath).isDirectory() || !lstatSync(providerPath).isDirectory())
    throw new Error('Unsafe provider archive root');
  const providerRoot = realpathSync(providerPath);

  for (const name of SELECTED) {
    const entry = new RegExp(
      "^  '" + name + "@file:([^'\\r\\n]+)':\\r?\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/]+={0,2}), tarball: file:([^,}\\r\\n]+)\\}",
      'gm'
    );
    const matches = [...lock.matchAll(entry)];
    if (matches.length !== 1) throw new Error('Missing or ambiguous locked provider: ' + name);
    const [, selectedPath, integrity, lockedPath] = matches[0]!;
    if (
      selectedPath !== lockedPath ||
      !/^vendor\/provider-migration\/[a-z0-9-]+\/[a-z0-9.-]+\.tgz$/.test(selectedPath!)
    ) {
      throw new Error('Invalid provider archive path: ' + name);
    }

    const expectedSpecifier = 'file:../../' + selectedPath;
    const dependency = new RegExp(
      "^      '" + name + "':\\n        specifier: ([^\\n]+)\\n        version: ([^\\n]+)(?:\\n|$)",
      'gm'
    );
    const importerMatches = [...dependencyBlock.matchAll(dependency)];
    const installedVersion = importerMatches[0]?.[2];
    const expectedVersion = 'file:' + selectedPath;
    if (manifest.dependencies?.[name] !== expectedSpecifier ||
        importerMatches.length !== 1 ||
        importerMatches[0]?.[1] !== expectedSpecifier ||
        (installedVersion !== expectedVersion &&
          !(installedVersion?.startsWith(expectedVersion + '(') && installedVersion.endsWith(')')))) {
      throw new Error('Host provider selection differs from pnpm lock: ' + name);
    }

    const archive = resolve(root, selectedPath!);
    if (!lstatSync(archive).isFile() || !realpathSync(archive).startsWith(providerRoot + sep)) {
      throw new Error('Unsafe provider archive: ' + name);
    }
    const expectedText = integrity!.slice('sha512-'.length);
    const expected = Buffer.from(expectedText, 'base64');
    const actual = createHash('sha512').update(readFileSync(archive)).digest();
    if (
      expected.length !== actual.length ||
      expected.toString('base64') !== expectedText ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new Error('Provider archive differs from pnpm lock: ' + name);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifySelectedProviderArchives(process.cwd());
  console.log('Selected provider archives match pnpm lock SHA-512');
}
