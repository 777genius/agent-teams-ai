import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const rendererRoot = dirname(fileURLToPath(import.meta.url));
const sourceExtensions = new Set(['.ts', '.tsx']);
const legacyRendererApiBoundary = join(rendererRoot, 'hooks', 'useGraphMemberLogPreviews.ts');

async function collectProductionSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectProductionSourceFiles(path);
      }
      if (!sourceExtensions.has(extname(entry.name)) || entry.name.includes('.test.')) {
        return [];
      }
      return [path];
    })
  );
  return files.flat();
}

describe('agent-graph renderer architecture', () => {
  it('keeps renderer production code behind feature-owned ports', async () => {
    const rendererApiModule = ['@renderer', 'api'].join('/');
    const teamsApiAccess = ['api', 'teams'].join('.');
    const processSendAccess = [teamsApiAccess, 'processSend'].join('.');
    const sourceFiles = await collectProductionSourceFiles(rendererRoot);

    for (const sourceFile of sourceFiles) {
      const source = await readFile(sourceFile, 'utf8');
      const sourceLabel = relative(rendererRoot, sourceFile);
      expect(source, `${sourceLabel} sends directly to a team process`).not.toContain(
        processSendAccess
      );

      // Member log polling is a separate, pre-existing transport migration lane.
      if (sourceFile === legacyRendererApiBoundary) continue;

      expect(source, `${sourceLabel} imports the renderer API`).not.toContain(rendererApiModule);
      expect(source, `${sourceLabel} calls the teams API`).not.toContain(teamsApiAccess);
    }
  });
});
