// Temporary exact-source authoring helper; never changes refs or merges.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const repository = '777genius/agent-teams-ai';
assert.equal(process.env.GITHUB_REPOSITORY, repository);
assert.equal(process.env.GITHUB_REF, 'refs/heads/fix/opencode-three-minute-loading');
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const extra = [
  'src/shared/constants/runtimeLoading.ts',
  'src/features/runtime-provider-management/renderer/hooks/runtimeProviderLoading.test.ts',
  'src/features/runtime-provider-management/main/infrastructure/RuntimeProviderLoadingBudget.test.ts',
  'docs/research/opencode-loading-budget.md',
];
const changed: string[] = [];
function edit(file: string, replacements: readonly (readonly [string, string])[], imported?: string) {
  let content = readFileSync(file, 'utf8');
  for (const [before, after] of replacements) {
    assert.equal(content.split(before).length - 1, 1, `Unique source fragment required in ${file}: ${before}`);
    content = content.replace(before, after);
  }
  if (imported) content = imported + '\n' + content;
  writeFileSync(file, content); changed.push(file);
}
if (!process.argv.includes('--publish-tree')) {
  assert.equal(git('rev-parse', 'HEAD^'), '8354469e8bb743a7b2f9da1525ce810228df640f');
  edit('src/features/runtime-provider-management/main/infrastructure/AgentTeamsRuntimeProviderManagementCliClient.ts', [
    ['const COMMAND_TIMEOUT_MS = 90_000;\n', ''],
  ], "import { PROVIDER_CLI_TIMEOUT_MS as COMMAND_TIMEOUT_MS } from '@shared/constants/runtimeLoading';");
  edit('src/features/runtime-provider-management/renderer/hooks/runtimeProviderManagementInternals.ts', [
    ['timeoutMs = 70_000', 'timeoutMs = PROVIDER_UI_TIMEOUT_MS'],
  ], "import { PROVIDER_UI_TIMEOUT_MS } from '@shared/constants/runtimeLoading';");
  edit('src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement.ts', [
    ['const CLEAR_PROJECT_DEFAULT_UI_TIMEOUT_MS = 100_000;\n', ''],
    ['CLEAR_PROJECT_DEFAULT_UI_TIMEOUT_MS', 'PROVIDER_UI_TIMEOUT_MS'],
  ], "import { PROVIDER_UI_TIMEOUT_MS } from '@shared/constants/runtimeLoading';");
  edit('src/main/services/team/opencode/bridge/OpenCodeReadinessTimeoutPolicy.ts', [
    ['launch: 120_000,', 'launch: OPENCODE_LOADING_TIMEOUT_MS,'],
    ['V1 keeps the historical 120s default.', 'V1 gets the shared three-minute cold-start allowance.'],
  ], "import { OPENCODE_LOADING_TIMEOUT_MS } from '@shared/constants/runtimeLoading';");
  writeFileSync('loading-budget-files.json', JSON.stringify([...changed, ...extra]));
  // Format only the exact edited/new source files, never the repository at large.
  execFileSync('pnpm', ['exec', 'prettier', '--write', ...changed, ...extra], { stdio: 'inherit' });
  execFileSync('git', ['diff', '--check'], { stdio: 'inherit' });
} else {
  const paths: string[] = JSON.parse(readFileSync('loading-budget-files.json', 'utf8'));
  assert.equal(paths.length, 8);
  assert(git('diff', '--name-only').split('\n').filter(Boolean).every(file => paths.includes(file)));
  async function post(route: string, body: unknown): Promise<{ sha: string }> {
    const response = await fetch(`https://api.github.com/repos/${repository}/git/${route}`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    assert(response.ok, `Git object upload failed: ${response.status}`);
    const value = await response.json() as { sha: string }; assert.match(value.sha, /^[a-f0-9]{40}$/); return value;
  }
  const entries: { path: string; mode: string; type: string; sha: string | null }[] = [];
  for (const file of paths) {
    const blob = await post('blobs', { content: readFileSync(file, 'utf8'), encoding: 'utf-8' });
    entries.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha });
  }
  for (const file of ['.github/apply-opencode-loading-budget.ts', '.github/workflows/opencode-loading-budget-authoring.yml']) {
    entries.push({ path: file, mode: '100644', type: 'blob', sha: null });
  }
  const tree = await post('trees', { base_tree: git('rev-parse', 'HEAD^{tree}'), tree: entries });
  const receipt = { parent: git('rev-parse', 'HEAD'), candidateTree: tree.sha, changed: paths };
  writeFileSync('candidate-tree.json', JSON.stringify(receipt, null, 2) + '\n');
  writeFileSync('candidate.patch', execFileSync('git', ['diff'], { encoding: 'utf8' }));
  console.log(JSON.stringify(receipt));
}
