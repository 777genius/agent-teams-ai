import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const stubs = {
  '@features/tmux-installer/main': 'export const listRuntimeProcessTableForCurrentPlatform = async () => [];',
  '@main/utils/windowsProcessTable': 'export const listWindowsProcessTable = async (...args) => globalThis.startupTestEnumeration(...args);',
  '@main/utils/processStartTime': 'export const readProcessStartTimeMs = async (...args) => globalThis.startupTestIdentity(...args);',
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    if (specifier.endsWith('/OpenCodeMcpBridgeEnv') || specifier === './OpenCodeMcpBridgeEnv') {
      return { url: 'data:text/javascript,export const OPENCODE_APP_PROFILE_FRAGMENT_KEY="agent-teams-app-profile"; export const OPENCODE_APP_PROFILE_SCOPE_ENV="CLAUDE_TEAM_APP_PROFILE_SCOPE";', shortCircuit: true };
    }
    if (specifier.startsWith('@main/')) specifier = pathToFileURL(resolve('src/main', specifier.slice(6))).href;
    if ((specifier.startsWith('.') || specifier.startsWith('file:')) && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      if (existsSync(new URL(`${url.href}.ts`))) return nextResolve(`${url.href}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
