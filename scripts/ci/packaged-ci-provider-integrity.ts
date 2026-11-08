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
  const providerRoot = realpathSync(resolve(root, 'vendor/provider-migration'));

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
      !/^vendor\/provider-migration\/[a-z0-9-]+\/[a-z0-9-]+\.tgz$/.test(selectedPath!)
    ) {
      throw new Error('Invalid provider archive path: ' + name);
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
