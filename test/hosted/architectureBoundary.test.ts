import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const HOSTED_SOURCE_ROOT = join(process.cwd(), 'src/hosted');
const APPROVED_HOSTED_APPLICATION_FACADE = '@main/application/hosted';

function listTypeScriptFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const absolutePath = join(root, entry);
    if (statSync(absolutePath).isDirectory()) return listTypeScriptFiles(absolutePath);
    return absolutePath.endsWith('.ts') || absolutePath.endsWith('.tsx') ? [absolutePath] : [];
  });
}

function extractImportSources(sourceText: string): string[] {
  const sources: string[] = [];
  const importPattern =
    /(?:import|export)\s+(?:type\s+)?(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(sourceText)) !== null) {
    sources.push(match[1] ?? match[2]);
  }
  return sources;
}

function isApprovedHostedApplicationFacade(source: string): boolean {
  return (
    source === APPROVED_HOSTED_APPLICATION_FACADE ||
    source.startsWith(`${APPROVED_HOSTED_APPLICATION_FACADE}/`)
  );
}

function isForbiddenHostedImport(source: string): boolean {
  if (isApprovedHostedApplicationFacade(source)) return false;
  return (
    source === 'electron' ||
    source.startsWith('@main/') ||
    source.startsWith('@preload/') ||
    source.startsWith('@renderer/') ||
    /^@features\/[^/]+\/(core|main|preload|renderer)\//.test(source) ||
    source.startsWith('../main') ||
    source.startsWith('../preload') ||
    source.startsWith('../renderer')
  );
}

describe('hosted architecture boundary', () => {
  it('keeps hosted source free of raw desktop internals', () => {
    const violations = listTypeScriptFiles(HOSTED_SOURCE_ROOT).flatMap((file) => {
      const sources = extractImportSources(readFileSync(file, 'utf-8'));
      return sources
        .filter(isForbiddenHostedImport)
        .map((source) => `${relative(process.cwd(), file)} imports ${source}`);
    });

    expect(violations).toEqual([]);
  });

  it('keeps lint guardrails aligned with the approved hosted application facade', () => {
    for (const configPath of ['eslint.config.js', 'eslint.fast.config.js']) {
      const configText = readFileSync(join(process.cwd(), configPath), 'utf-8');
      expect(configText).toContain('hosted-composition-boundary');
      expect(configText).toContain('@main/**');
      expect(configText).toContain('!@main/application/hosted');
      expect(configText).toContain('!@main/application/hosted/**');
      expect(configText).toContain('@features/*/core/**');
      expect(configText).toContain('@features/*/main/**');
      expect(configText).toContain('@features/*/preload/**');
      expect(configText).toContain('@features/*/renderer/**');
      expect(configText).toContain('not raw desktop internals');
    }
  });
});
