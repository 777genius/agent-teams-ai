import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { assertAbsolute } from './fsutil.mjs';

const PROVIDER_KEYS = { anthropic: ['oauthTokenFile'], codex: ['codexHome', 'codexCliPath'] };

const inside = (path, root) => path === root || path.startsWith(`${root}/`);

/**
 * Parses `nativeProviders` from the launcher config into the exact header shape Owner compares:
 * anthropic before codex, only known keys, at least one provider, canonical absolute paths outside
 * the Claude root (agents and Product can write there). Only paths travel; never a secret.
 */
export function parseNativeProviders(raw, claudeRoot) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('hostedctl-config-native-providers-invalid');
  const names = Object.keys(raw);
  if (names.length === 0 || names.some(name => !(name in PROVIDER_KEYS))) {
    throw new Error('hostedctl-config-native-providers-invalid');
  }
  const parsed = {};
  for (const name of Object.keys(PROVIDER_KEYS).filter(key => key in raw)) {
    const value = raw[name];
    const keys = PROVIDER_KEYS[name];
    if (!value || typeof value !== 'object' ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
      throw new Error(`hostedctl-config-native-provider-invalid:${name}`);
    }
    parsed[name] = Object.freeze(Object.fromEntries(keys.map(key => {
      const path = assertAbsolute(value[key], `config-native-${name}-${key}`);
      if (inside(path, claudeRoot)) throw new Error(`hostedctl-config-native-path-inside-claude-root:${name}.${key}`);
      return [key, path];
    })));
  }
  return Object.freeze(parsed);
}

/** Checked before every Owner start; Owner and its lane check the same files again. */
export async function assertNativeProviders(nativeProviders, { uid, claudeRoot }) {
  if (!nativeProviders) return null;
  const canonical = async path => {
    const real = await realpath(path);
    if (real !== path || inside(real, claudeRoot)) throw new Error(`hostedctl-native-path-invalid:${path}`);
  };
  if (nativeProviders.anthropic) {
    const path = nativeProviders.anthropic.oauthTokenFile;
    await canonical(path);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.uid !== uid || (entry.mode & 0o077) !== 0 || entry.size < 16 || entry.size > 8192 + 64) {
      throw new Error('hostedctl-native-anthropic-token-file-custody-invalid');
    }
  }
  if (nativeProviders.codex) {
    const { codexHome, codexCliPath } = nativeProviders.codex;
    await canonical(codexHome);
    await canonical(codexCliPath);
    if (!(await lstat(codexHome)).isDirectory()) throw new Error('hostedctl-native-codex-home-invalid');
    const cli = await lstat(codexCliPath);
    if (!cli.isFile()) throw new Error('hostedctl-native-codex-cli-invalid');
    await access(codexCliPath, constants.X_OK);
  }
  return nativeProviders;
}
