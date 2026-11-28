import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readNativePlugins } from '../../packages/legacy-agent-host/dist/extensions/readNativeExtensionState.js';
import {
  EXTENSION_USER_SKILL, EXTENSION_PROJECT_SKILL, EXTENSION_USER_BODY,
  EXTENSION_PROJECT_BODY_A, EXTENSION_PROJECT_BODY_B,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-extensions/model.ts';
import type {
  NativeExtensionUiPhase, NativeExtensionInvocation, NativeExtensionUiScenario,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-extensions/model.ts';
import { prepareDesktopBackendFixture, digest, fileDigest } from './desktop-backend-fixture.ts';
import {
  prepareDesktopNativeExtensionsFixture, nativeExtensionNamespaceDigest, extensionPlugin,
} from './desktop-native-extensions-fixture.ts';
import type { NativeExtensionProofSelection } from './desktop-native-extensions-fixture.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

export const nativeExtensionUiState = (root: string) => join(root, 'native-extension-ui-state.json');
export const nativeExtensionUiSources = (root: string) => join(root, 'native-extension-ui-sources.json');
export type NativeExtensionSources = {
  namespaceSha256: string;
  plugin: { id: string; version: string; scope: 'user'; installPath: string; sourceSha256: string };
  invocations: Record<Exclude<NativeExtensionUiPhase, 'idle'>,
    NativeExtensionInvocation & { sourcePath: string }>;
};

export async function prepareDesktopNativeExtensionConsumptionFixture(
  repo: string, pnpmEntry: string, modelUrl: string
) {
  const fixture = await prepareDesktopNativeExtensionsFixture(
    await prepareDesktopBackendFixture(repo, {
      pnpmEntry, seedUiTask: true, launchDialog: true,
      nativeClaude: { path: process.env.LEGACY_DESKTOP_CLAUDE_PATH!,
        sha256: 'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f', modelUrl },
    }), { sameRuntimeNamespace: true });
  // Existing custom-folder discovery exposes this zero-session project to the ordinary Team/Extensions UI.
  const configPath = join(fixture.root, 'claude/agent-teams-config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    general: Record<string, unknown>;
  };
  config.general.customProjectPaths = [join(fixture.root, 'workspace')];
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await writeFile(nativeExtensionUiState(fixture.root), JSON.stringify({ phase: 'idle' }),
    { mode: 0o600, flag: 'wx' });
  return fixture;
}

/** Read only this installed package/version from the native inventory; no scanner or metadata mutation. */
export async function captureDesktopNativeExtensionSources(root: string): Promise<NativeExtensionSources> {
  const selected = JSON.parse(await readFile(join(root, 'native-extensions-selection.json'), 'utf8')) as NativeExtensionProofSelection;
  const profile = JSON.parse(await readFile(join(root, 'host-profile.json'), 'utf8')) as TeamHostProfile;
  const runtime = profile.runtime?.members[0];
  assert.equal(runtime?.provider, 'claude');
  if (!runtime || runtime.provider !== 'claude') throw new Error('Captured Claude source missing');
  assert.equal(nativeExtensionNamespaceDigest({ ...runtime,
    settingSources: runtime.nativeOptions?.settingSources }), selected.runtimeNamespaceSha256);
  assert.equal(nativeExtensionNamespaceDigest(selected.profile), selected.runtimeNamespaceSha256);
  const inventory = () => readNativePlugins(selected.profile, true, () => {}).entries
    .filter(row => row.pluginId === extensionPlugin);
  const installed = inventory();
  assert.equal(installed.length, 1);
  const plugin = installed[0]!;
  assert.equal(plugin.scope, 'user');
  assert.ok(plugin.version && plugin.installPath);
  const installPath = await realpath(plugin.installPath);
  assert.equal(installPath, plugin.installPath);
  assert.ok(installPath.startsWith(join(selected.profile.environment.CLAUDE_CONFIG_DIR!, 'plugins') + '/'));
  const source = async (path: string) => {
    const canonical = await realpath(path);
    assert.equal(canonical, path);
    assert.ok(canonical.startsWith(root + '/'));
    const stat = await lstat(canonical);
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 128 * 1024);
    const sha256 = await fileDigest(canonical);
    const text = await readFile(canonical, 'utf8');
    assert.equal(digest(text), sha256);
    assert.equal(await fileDigest(canonical), sha256);
    return { text, sha256, path: canonical };
  };
  const pluginSource = await source(join(installPath, 'skills/frontend-design/SKILL.md'));
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(pluginSource.text);
  assert.ok(frontmatter && /^name:\s*frontend-design\s*$/m.test(frontmatter[1]!));
  const body = pluginSource.text.slice(frontmatter[0].length);
  const paragraph = body.split(/\r?\n\s*\r?\n/).map(value => value.replace(/\s+/g, ' ').trim())
    .find(value => value.length >= 160 && !value.startsWith('#'));
  assert.ok(paragraph, 'substantive installed body fragment distinct from frontmatter/arguments');
  const fragment = paragraph.slice(0, 512);
  const user = await source(join(selected.profile.environment.CLAUDE_CONFIG_DIR!,
    'skills', EXTENSION_USER_SKILL, 'SKILL.md'));
  const project = await source(join(selected.profile.cwd, '.claude/skills',
    EXTENSION_PROJECT_SKILL, 'SKILL.md'));
  assert.ok(user.text.includes(EXTENSION_USER_BODY));
  assert.ok(project.text.includes(EXTENSION_PROJECT_BODY_B));
  assert.equal(project.text.includes(EXTENSION_PROJECT_BODY_A), false);
  assert.deepEqual(inventory(), installed, 'original native package/version inventory unchanged during read');
  const result: NativeExtensionSources = {
    namespaceSha256: selected.runtimeNamespaceSha256!,
    plugin: { id: extensionPlugin, version: plugin.version, scope: 'user', installPath,
      sourceSha256: pluginSource.sha256 },
    invocations: {
      'user-skill': { name: EXTENSION_USER_SKILL, args: 'TEST_R10_USER_ARGS',
        fragment: EXTENSION_USER_BODY, sourcePath: user.path, sourceSha256: user.sha256 },
      'project-skill': { name: EXTENSION_PROJECT_SKILL, args: 'TEST_R10_PROJECT_ARGS',
        fragment: EXTENSION_PROJECT_BODY_B, absentFragment: EXTENSION_PROJECT_BODY_A,
        sourcePath: project.path, sourceSha256: project.sha256 },
      plugin: { name: 'frontend-design:frontend-design', args: 'TEST_R10_PLUGIN_ARGS',
        fragment, sourcePath: pluginSource.path, sourceSha256: pluginSource.sha256 },
    },
  };
  await writeFile(nativeExtensionUiSources(root), JSON.stringify(result), { mode: 0o600, flag: 'wx' });
  return result;
}

export function desktopNativeExtensionScenario(root: () => string): NativeExtensionUiScenario {
  return {
    phase() {
      const row = JSON.parse(readFileSync(nativeExtensionUiState(root()), 'utf8')) as {
        phase: NativeExtensionUiPhase;
      };
      assert.ok(['idle', 'user-skill', 'project-skill', 'plugin'].includes(row.phase));
      return row.phase;
    },
    invocation(phase) {
      const sources = JSON.parse(readFileSync(nativeExtensionUiSources(root()), 'utf8')) as NativeExtensionSources;
      const selected = sources.invocations[phase];
      assert.ok(selected && selected.sourcePath.startsWith(root() + '/'));
      assert.equal(digest(readFileSync(selected.sourcePath, 'utf8')), selected.sourceSha256,
        'native command consumes the same installed/edited bytes captured before Launch');
      return selected;
    },
  };
}
