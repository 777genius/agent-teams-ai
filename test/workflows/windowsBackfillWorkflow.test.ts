// @vitest-environment node
// Static workflow contract checks. These do not claim PowerShell/Windows execution.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const text = readFileSync('.github/workflows/windows-backfill-diagnostic.yml', 'utf8');
const workflow = parse(text);
const job = workflow.jobs['packaged-backfill'];
const steps = job.steps as {
  name?: string;
  id?: string;
  run?: string;
  env?: Record<string, string>;
}[];
const validation = steps.find((step) => step.id === 'runtime')!;
const download = steps.find((step) => step.name?.startsWith('Download and verify'))!;
const integration = readFileSync(
  'test/main/services/team/OpenCodePackagedBackfill.windows.test.ts',
  'utf8'
);

// Exercise the literal .NET regex bodies with equivalent absolute JS anchors.
const patterns = [...validation.run!.matchAll(/-c?notmatch '([^']+)'/g)].map(
  ([, pattern]) => new RegExp(pattern.replace('\\A', '^').replace('\\z', '$(?![\\s\\S])'))
);

describe('Windows draft backfill workflow contract', () => {
  it('exposes only an optional all-or-none manual tuple, validated before checkout/download', () => {
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual([
      'runtime_version',
      'runtime_archive_sha256',
      'runtime_source_sha',
    ]);
    for (const input of Object.values(workflow.on.workflow_dispatch.inputs)) {
      expect(input).toMatchObject({ type: 'string', required: false });
    }
    expect(steps.indexOf(validation)).toBe(1);
    expect(validation.run).toContain("$env:GITHUB_EVENT_NAME -ne 'workflow_dispatch'");
    expect(validation.run).toContain("$custom = ($version -ne ''");
    expect(validation.run).toContain("$digest -ne ''");
    expect(validation.run).toContain("$source -ne ''");
    expect(validation.run).toContain("$version = '0.0.87'");
    expect(validation.run).toContain(
      "$digest = 'f4f36d3f3697fcb3208e7bfc784829a447d8c7faf65570479fa0b4a92ed1ef5d'"
    );
    for (const step of steps) expect(step.run ?? '').not.toMatch(/\$\{\{\s*inputs\./);
  });

  it('rejects partial tuples and unsafe/non-exact input shapes', () => {
    expect(patterns).toHaveLength(3);
    const valid = ['0.0.88', 'a'.repeat(64), 'B'.repeat(40)];
    expect(patterns.every((pattern, i) => pattern.test(valid[i]))).toBe(true);
    for (let mask = 1; mask < 7; mask++) {
      expect(patterns.every((pattern, i) => pattern.test(mask & (1 << i) ? valid[i] : ''))).toBe(
        false
      );
    }
    for (const value of [
      'v0.0.88',
      'latest',
      '01.2.3',
      '../0.0.88',
      '0.0.88*',
      '0.0.88\n',
      '0.0.88\r\n',
      ' 0.0.88',
      '0.0.88; whoami',
      '$(whoami)',
      '0.0.88/asset',
    ]) {
      expect(patterns[0].test(value), value).toBe(false);
    }
    for (const [index, size] of [
      [1, 64],
      [2, 40],
    ]) {
      for (const value of [
        'a'.repeat(size - 1),
        'a'.repeat(size + 1),
        'g'.repeat(size),
        `${'a'.repeat(size)}\n`,
      ]) {
        expect(patterns[index].test(value)).toBe(false);
      }
    }
  });

  it('confines draft credentials and keeps repository, tag and asset construction fixed', () => {
    expect(job.if).toBe(
      "github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository"
    );
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(download.env!.GH_TOKEN).toBe(
      "${{ github.event_name == 'workflow_dispatch' && steps.runtime.outputs.custom == 'true' && secrets.RUNTIME_BUILD_DISPATCH_TOKEN || '' }}"
    );
    expect(download.run).toContain(
      'if ($custom -and [string]::IsNullOrEmpty($env:GH_TOKEN)) { throw'
    );
    expect(download.run).toContain('$tag = "runtime-v$requestedVersion"');
    expect(download.run).toContain(
      '$asset = "agent-teams-runtime-win32-x64-v$requestedVersion.zip"'
    );
    expect(download.run).toContain(
      'gh release download $tag --repo 777genius/agent_teams_orchestrator_binaries --pattern $asset'
    );
    expect(text).not.toMatch(/pull_request_target|gh release (create|edit|upload)|contents: write/);
    expect(job.env.WINDOWS_BACKFILL_SUPPORT_SHA).toBe('391ce5c8915951e1c412c84ff2970ab9065e4ac6');
  });

  it('gates extraction and execution on archive and embedded metadata and records selected provenance', () => {
    const script = download.run!;
    expect(script.indexOf('if ($actual -ne $expected) { throw')).toBeLessThan(
      script.indexOf('Expand-Archive')
    );
    expect(script).toContain('$version -cne $requestedVersion');
    expect(script).toContain('if ($custom -and $runtimeSha -cne $expectedSource) { throw');
    expect(script.indexOf("throw 'Runtime COMMIT_SHA mismatch'")).toBeLessThan(
      script.indexOf('"WINDOWS_BACKFILL_EXE=')
    );
    expect(script).toContain('expectedRuntimeSourceSha = $expectedSource');
    expect(script).toContain("'manual-qualification' } else { 'shipped-default'");
    expect(integration).toContain('expect(report.archiveSha256).toBe(runtimeArchiveSha256)');
    expect(integration).toContain('expect(report.runtimeBuildSourceSha).toBe(runtimeSourceSha)');
    expect(integration).toContain('runtimeRelease: `runtime-v${runtimeVersion}`');
    expect(integration).toContain('const result = await delegate.run(input)');
  });
});
