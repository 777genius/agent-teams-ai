import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readPrivateJson, validatePrivatePath } from '@features/local-http-auth/main';

interface CopyConfig {
  schemaVersion: 1;
  context: { appInstanceId: string; dataRootFingerprint: string; connectionGeneration: number };
  profileFingerprint: string;
  root: string;
  controlUrl: string;
  authReference: string;
}

/** No credential material is accepted by this schema. Paths select existing protected authority. */
export function parseCopyConfig(value: unknown, file: string): CopyConfig {
  const item = value as Partial<CopyConfig> | null;
  if (
    !item ||
    typeof item !== 'object' ||
    Array.isArray(item) ||
    Object.keys(item)
      .sort((left, right) => left.localeCompare(right))
      .join(',') !==
      'authReference,context,controlUrl,profileFingerprint,root,schemaVersion' ||
    item.schemaVersion !== 1 ||
    typeof item.root !== 'string' ||
    !path.isAbsolute(item.root) ||
    path.resolve(item.root) !== item.root ||
    typeof item.controlUrl !== 'string' ||
    typeof item.authReference !== 'string' ||
    typeof item.profileFingerprint !== 'string'
  )
    throw new Error('Invalid copy connection config');
  if (
    !path.isAbsolute(file) ||
    path.resolve(file) !== file ||
    path.basename(path.dirname(file)) !== 'copy-handoffs' ||
    path.basename(path.dirname(path.dirname(file))) !== 'local-http-auth' ||
    !/^[a-f0-9-]{36}\.json$/.test(path.basename(file))
  )
    throw new Error('Invalid copy connection config');
  const userData = path.dirname(path.dirname(path.dirname(file)));
  if (item.profileFingerprint !== createHash('sha256').update(userData).digest('hex'))
    throw new Error('Invalid copy connection profile');
  const context = item.context;
  if (
    !context ||
    typeof context !== 'object' ||
    Array.isArray(context) ||
    Object.keys(context)
      .sort((left, right) => left.localeCompare(right))
      .join(',') !==
      'appInstanceId,connectionGeneration,dataRootFingerprint' ||
    typeof context.appInstanceId !== 'string' ||
    !context.appInstanceId.trim() ||
    context.appInstanceId.length > 128 ||
    context.dataRootFingerprint !== createHash('sha256').update(item.root).digest('hex') ||
    !Number.isSafeInteger(context.connectionGeneration) ||
    context.connectionGeneration < 1
  )
    throw new Error('Invalid copy connection context');
  const url = new URL(item.controlUrl);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.origin !== item.controlUrl
  )
    throw new Error('Invalid copy connection endpoint');
  if (
    path.dirname(item.authReference) !== path.join(item.root, 'local-http-auth') ||
    !/^api-[a-f0-9-]{36}\.ref\.json$/.test(path.basename(item.authReference))
  )
    throw new Error('Invalid copy connection authority reference');
  return item as CopyConfig;
}

/** Client MCP env normally merges inherited provider settings. This child replaces that environment. */
export function isolateCopyEnvironment(env: NodeJS.ProcessEnv, config: CopyConfig): void {
  const allowed = [
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
  ];
  const runtime = Object.fromEntries(allowed.flatMap((key) => (env[key] ? [[key, env[key]]] : [])));
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, runtime, {
    AGENT_TEAMS_BOUND_CONTROL_URL: config.controlUrl,
    AGENT_TEAMS_BOUND_CONTEXT_JSON: JSON.stringify(config.context),
    AGENT_TEAMS_MCP_CLAUDE_DIR: config.root,
    CLAUDE_TEAM_CONTROL_AUTH_REF: config.authReference,
  });
}

export async function startCopyHandoff(argv = process.argv): Promise<void> {
  if (argv.length !== 4 || argv[2] !== '--handoff')
    throw new Error('Invalid copy connection invocation');
  const file = argv[3];
  const config = parseCopyConfig(await readPrivateJson(file), file);
  await validatePrivatePath(path.dirname(file), true);
  // Validate the immutable launch selector now; the bound controller validates the actual authority.
  await validatePrivatePath(config.authReference);
  isolateCopyEnvironment(process.env, config);
  process.argv = [
    process.execPath,
    argv[1],
    '--transport',
    'stdio',
    '--tool-profile',
    'management',
  ];
  // A computed sibling URL is intentional: bundling must not eagerly import controller bindings.
  const sibling = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js')
  ).href;
  const server = (await import(sibling)) as { main(): Promise<void> };
  await server.main();
}

function isEntrypoint(): boolean {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (isEntrypoint()) {
  startCopyHandoff().catch(() => {
    // Never leak private paths, descriptor contents or authority errors to the agent transcript.
    console.error(
      'Copy connection unavailable. Copy a fresh prompt from the local app and reload MCP.'
    );
    process.exitCode = 1;
  });
}
