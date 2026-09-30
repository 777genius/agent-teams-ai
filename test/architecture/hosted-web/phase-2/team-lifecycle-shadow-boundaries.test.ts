import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const COMPARATOR_PATH =
  'src/features/team-lifecycle/main/infrastructure/TeamLifecycleProjectionShadowComparator.ts';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function productionTypeScriptFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (relativeDirectory: string): void => {
    const directory = path.join(root, relativeDirectory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(relativePath);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        files.push(path.join(root, relativePath));
      }
    }
  };
  visit('');
  return files;
}

function importSpecifiers(source: string): readonly string[] {
  return [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
}

describe('team-lifecycle projection shadow boundaries', () => {
  it('depends only on canonical value contracts and the existing legacy identity binding types', () => {
    const source = read(COMPARATOR_PATH);

    expect(importSpecifiers(source)).toEqual([
      '@shared/contracts/hosted',
      '../../contracts/team-lifecycle-read',
      './LegacyTeamLifecycleReadSource',
    ]);
    for (const specifier of importSpecifiers(source)) {
      expect(specifier).not.toMatch(
        /(?:electron|fastify|renderer|(?:^|\/)(?:fs|path|child_process)(?:$|\/)|internal-storage|TeamDataService|composition)/i
      );
    }
    expect(source).toContain('type CanonicalListTeamLifecycleResult');
    expect(source).toContain('type TeamLifecycleState');
    expect(source).toContain('LegacyTeamBindingPage');
    expect(source).toContain('LegacyTeamIdentityBinding');
    expect(source).toContain('LegacyTeamReadAvailability');
    expect(source).not.toMatch(
      /^\s*(?:export\s+)?(?:interface|type)\s+(?:TeamId|WorkspaceId|Revision|Cursor|TeamLifecycleState)\b\s*(?:=|\{)/m
    );
  });

  it('has no runtime, transport, storage, clock, environment, reporting, or global-state access', () => {
    const source = read(COMPARATOR_PATH);
    const forbiddenRuntime =
      /(?:\belectron\b|\bfastify\b|node:(?:fs|path|child_process)|\bSQLite\b|\bipcMain\b|\bipcRenderer\b|\bBrowserWindow\b|\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bsetTimeout\b|\bsetInterval\b|\bDate\.(?:now|parse)\b|\bperformance\.|\bprocess\.|\bimport\.meta\.env\b|\bglobalThis\b|\bwindow\.|\bdocument\.|\bMath\.random\b|\bconsole\.|\blogger\.|\btelemetry\b|TeamDataService|internal-storage)/i;

    expect(forbiddenRuntime.test("import { readFile } from 'node:fs'")).toBe(true);
    expect(forbiddenRuntime.test('process.env.SECRET')).toBe(true);
    expect(forbiddenRuntime.test('console.info(value)')).toBe(true);
    expect(source).not.toMatch(forbiddenRuntime);
  });

  it('keeps legacy correlation internal and exposes only bounded safe report values', () => {
    const source = read(COMPARATOR_PATH);
    const reportStart = source.indexOf('export interface TeamLifecycleProjectionShadowFinding');
    const reportEnd = source.indexOf('type CanonicalSuccess');
    const reportSurface = source.slice(reportStart, reportEnd);

    expect(reportSurface).toContain('readonly code: TeamLifecycleProjectionShadowFindingCode');
    expect(reportSurface).toContain('readonly teamId?: TeamId');
    expect(reportSurface).toContain('readonly snapshotRevision: Revision | null');
    expect(reportSurface).toContain('readonly comparedCount: number');
    expect(reportSurface).toContain(
      'readonly findings: readonly TeamLifecycleProjectionShadowFinding[]'
    );
    expect(reportSurface).not.toMatch(
      /legacyTeamName|projectPath|rootPath|filePath|config|runId|raw|unknown/
    );
    expect(source).toContain('TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_BINDINGS = 1_000');
    expect(source).toContain('TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_LEGACY_ITEMS = 2_000');
    expect(source).toContain('TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_FINDINGS = 4_001');
    expect(source).toContain('Object.freeze');
    expect(source).toContain('.sort(compareFindings)');
  });

  it('is phase-neutral and remains absent from every production composition and public barrel', () => {
    const comparator = read(COMPARATOR_PATH);
    const consumers = productionTypeScriptFiles('src')
      .filter((relativePath) => relativePath !== COMPARATOR_PATH)
      .filter((relativePath) =>
        read(relativePath).includes('TeamLifecycleProjectionShadowComparator')
      );

    expect(comparator).not.toMatch(/\bPhase2\w*|phase-2/i);
    expect(consumers).toEqual([]);
  });
});
