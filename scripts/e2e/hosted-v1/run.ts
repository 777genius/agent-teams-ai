import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import {
  access,
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { encodeReplayCursor } from '../../../src/features/coordination-events';
import {
  assertHostedV1MarkerOwnedRoot,
  createHostedV1Sandbox,
  E2E_RUNTIME_WORKSPACE_ID,
  E2E_TEAM_ID,
  E2E_TEAM_NAME,
  E2E_WORKSPACE_ID,
  type HostedV1Sandbox,
} from '../../../test/fixtures/hosted-v1/createSandbox';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const composeFile = join(repositoryRoot, 'docker', 'docker-compose.e2e.yml');
const playwrightConfig = join(repositoryRoot, 'test', 'e2e', 'hosted-v1', 'playwright.config.ts');
const requiredDigest = /^sha256:[0-9a-f]{64}$/;
const providerEnvironmentKey =
  /(?:ANTHROPIC|CLAUDE|CODEX|OPENAI|OPENCODE|GEMINI|GOOGLE.*API|CURSOR|GITHUB_TOKEN|GH_TOKEN|API_KEY|AUTH_TOKEN|OAUTH_TOKEN)/i;
const ambientContainerContextKey = /^(?:COMPOSE_|DOCKER_CONTEXT$|DOCKER_HOST$)/u;
const sanitizedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !providerEnvironmentKey.test(key) && !ambientContainerContextKey.test(key)
  )
);
const deploymentId = 'deployment_hosted-v1-e2e';
type ScenarioMode = 'oidc' | 'oidc-viewer' | 'personal';
export const COMPOSE_BIND_ATTEMPT_LIMIT = 3;

interface ComposeUpRetryInput {
  readonly buildImage?: () => Promise<void>;
  readonly cleanupBindCollision: (environment: NodeJS.ProcessEnv) => Promise<void>;
  readonly createEnvironment: (port: number) => NodeJS.ProcessEnv;
  readonly selectPort: () => Promise<number>;
  readonly up: (environment: NodeJS.ProcessEnv) => Promise<void>;
}

function commandErrorOutput(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const commandError = error as Error & { readonly stderr?: unknown; readonly stdout?: unknown };
  return [commandError.message, commandError.stderr, commandError.stdout]
    .filter((value) => typeof value === 'string' || Buffer.isBuffer(value))
    .map(String)
    .join('\n');
}

export function isDockerHostPortBindCollision(error: unknown, port: number): boolean {
  const output = commandErrorOutput(error);
  return (
    /error response from daemon/iu.test(output) &&
    /(?:failed to set up container networking|driver failed programming external connectivity|failed to bind host port)/iu.test(
      output
    ) &&
    new RegExp(`127\\.0\\.0\\.1:${port}(?:->\\d+)?`, 'u').test(output) &&
    /(?:port is already allocated|address already in use)/iu.test(output)
  );
}

export async function runComposeUpWithExactBindRetry(
  input: ComposeUpRetryInput
): Promise<NodeJS.ProcessEnv> {
  await input.buildImage?.();
  for (let attempt = 1; attempt <= COMPOSE_BIND_ATTEMPT_LIMIT; attempt += 1) {
    const port = await input.selectPort();
    const environment = input.createEnvironment(port);
    try {
      await input.up(environment);
      return environment;
    } catch (error) {
      if (!isDockerHostPortBindCollision(error, port) || attempt === COMPOSE_BIND_ATTEMPT_LIMIT) {
        throw error;
      }
      await input.cleanupBindCollision(environment);
    }
  }
  throw new Error('hosted_e2e_compose_retry_invariant');
}

function envDigest(
  name: 'NODE_IMAGE_DIGEST' | 'CADDY_IMAGE_DIGEST' | 'KEYCLOAK_IMAGE_DIGEST'
): string {
  const value = process.env[name];
  if (!value || !requiredDigest.test(value)) {
    throw new Error(`${name} must be an audited sha256 digest`);
  }
  return value;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('e2e_port_unavailable');
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose()))
  );
  return address.port;
}

async function run(
  command: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly capture?: boolean } = {}
): Promise<string> {
  if (options.capture) {
    const result = await execFileAsync(command, [...args], {
      cwd: repositoryRoot,
      env: options.env ?? sanitizedEnvironment,
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout.trim();
  }
  await new Promise<void>((resolveExit, reject) => {
    const child = spawn(command, [...args], {
      cwd: repositoryRoot,
      env: options.env ?? sanitizedEnvironment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveExit();
      else reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown'}`));
    });
  });
  return '';
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNoComposeResourcesRemain(remaining: string): void {
  if (remaining !== '') throw new Error('hosted_e2e_compose_orphans_remain');
}

function redactEvidence(
  value: string,
  sandbox: HostedV1Sandbox,
  pairingCode: string | null
): string {
  let redacted = value.replaceAll(sandbox.root, '<sandbox-root>');
  if (pairingCode) redacted = redacted.replaceAll(pairingCode, '<pairing-code>');
  return redacted
    .replace(/(__Host-agent-teams-[A-Za-z0-9_-]+=)[^;\s]+/gu, '$1<cookie>')
    .replace(/([?&](?:code|state)=)[^&\s"']+/giu, '$1<oidc-value>')
    .replace(/(x-agent-teams-csrf["':=\s]+)[A-Za-z0-9_-]{32,}/giu, '$1<csrf-token>')
    .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/gu, '<jwt>')
    .slice(0, 16 * 1024 * 1024);
}

async function writeEvidence(path: string, value: string): Promise<void> {
  await writeFile(path, value.endsWith('\n') ? value : `${value}\n`, { mode: 0o600 });
}

async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error('hosted_e2e_fixture_symlink_refused');
  await chown(path, uid, gid);
  if (!stat.isDirectory()) return;
  for (const entry of await readdir(path)) await chownTree(join(path, entry), uid, gid);
}

interface ArtifactOwner {
  readonly uid: number;
  readonly gid: number;
}

function invokingSudoOwner(): ArtifactOwner | null {
  const uid = process.env.SUDO_UID;
  const gid = process.env.SUDO_GID;
  return uid && gid && /^\d+$/u.test(uid) && /^\d+$/u.test(gid)
    ? { uid: Number(uid), gid: Number(gid) }
    : null;
}

async function createEvidenceDirectory(
  sandbox: HostedV1Sandbox,
  artifactOwner: ArtifactOwner | null
): Promise<string> {
  const configured = process.env.HOSTED_E2E_ARTIFACT_DIR;
  if (!configured || !isAbsolute(configured) || resolve(configured) !== configured) {
    throw new Error('HOSTED_E2E_ARTIFACT_DIR must be an absolute canonical directory');
  }
  await mkdir(configured, { recursive: true, mode: 0o700 });
  const canonical = await realpath(configured);
  const stat = await lstat(configured);
  if (
    canonical !== configured ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error('HOSTED_E2E_ARTIFACT_DIR must be private and canonical');
  }
  const relation = relative(sandbox.root, canonical);
  if (
    !relation ||
    (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
  ) {
    throw new Error('HOSTED_E2E_ARTIFACT_DIR must be outside the disposable sandbox');
  }
  const repositoryRelation = relative(repositoryRoot, canonical);
  if (
    !repositoryRelation ||
    (!repositoryRelation.startsWith(`..${sep}`) &&
      repositoryRelation !== '..' &&
      !isAbsolute(repositoryRelation))
  ) {
    throw new Error('HOSTED_E2E_ARTIFACT_DIR must be outside the repository');
  }
  if (artifactOwner !== null) {
    // The root-run harness creates this private parent. Give the invoking runner ownership so the
    // post-sudo artifact uploader can traverse it; keep 0700 and marker-owned children unchanged.
    await chown(canonical, artifactOwner.uid, artifactOwner.gid);
    await chmod(canonical, 0o700);
  }
  const directory = join(canonical, `hosted-v1-${sandbox.marker}`);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

async function captureFailureEvidence(input: {
  readonly artifactDirectory: string;
  readonly authMode: ScenarioMode;
  readonly composeArgs: readonly string[];
  readonly composeEnv: NodeJS.ProcessEnv;
  readonly error: unknown;
  readonly pairingCode: string | null;
  readonly sandbox: HostedV1Sandbox;
}): Promise<void> {
  const scenarioDirectory = join(input.artifactDirectory, input.authMode);
  await mkdir(scenarioDirectory, { recursive: true, mode: 0o700 });
  await writeEvidence(
    join(scenarioDirectory, 'failure.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        authMode: input.authMode,
        status: 'failed',
        error: redactEvidence(safeError(input.error), input.sandbox, input.pairingCode),
      },
      null,
      2
    )
  );
  for (const [name, args] of [
    ['compose.log', [...input.composeArgs, 'logs', '--no-color', '--timestamps']],
    ['compose-ps.json', [...input.composeArgs, 'ps', '--all', '--format', 'json']],
  ] as const) {
    try {
      const output = await run('docker', args, { env: input.composeEnv, capture: true });
      await writeEvidence(
        join(scenarioDirectory, name),
        redactEvidence(output, input.sandbox, input.pairingCode)
      );
    } catch (captureError) {
      await writeEvidence(
        join(scenarioDirectory, `${name}.error`),
        redactEvidence(safeError(captureError), input.sandbox, input.pairingCode)
      );
    }
  }
}

function networkAddresses(marker: string): {
  readonly app: string;
  readonly caddy: string;
  readonly subnet: string;
} {
  const value = Number.parseInt(marker.slice(0, 4), 16);
  const prefix = `10.${64 + ((value >> 8) % 64)}.${value & 0xff}`;
  return Object.freeze({ app: `${prefix}.3`, caddy: `${prefix}.2`, subnet: `${prefix}.0/28` });
}

async function main(): Promise<void> {
  const nodeDigest = envDigest('NODE_IMAGE_DIGEST');
  const caddyDigest = envDigest('CADDY_IMAGE_DIGEST');
  const keycloakDigest = envDigest('KEYCLOAK_IMAGE_DIGEST');
  await run('docker', ['version'], { capture: true });
  await access(composeFile);

  const root = await mkdtemp(join(await realpath(tmpdir()), 'agent-teams-hosted-v1-e2e-'));
  let sandbox: HostedV1Sandbox;
  try {
    sandbox = await createHostedV1Sandbox(root);
  } catch (error) {
    const markerPath = join(root, '.agent-teams-hosted-v1-e2e-owner.json');
    try {
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
        readonly marker?: unknown;
      };
      if (typeof marker.marker === 'string') {
        await assertHostedV1MarkerOwnedRoot(root, markerPath, marker.marker);
        await rm(root, { recursive: true });
      }
    } catch {
      // Refuse destructive cleanup when fixture ownership could not be proven.
    }
    throw error;
  }

  const artifactOwner = invokingSudoOwner();
  let artifactDirectory: string;
  try {
    artifactDirectory = await createEvidenceDirectory(sandbox, artifactOwner);
  } catch (error) {
    await assertHostedV1MarkerOwnedRoot(sandbox.root, sandbox.markerPath, sandbox.marker);
    await rm(sandbox.root, { recursive: true });
    throw error;
  }
  let rootRemovable = true;
  try {
    const projectSuffix = sandbox.marker.slice(0, 24);
    const composeProject = `at-hosted-v1-${projectSuffix}`;
    if (!projectSuffix || composeProject.length > 63) throw new Error('e2e_project_name_invalid');
    if (process.getuid?.() !== 0)
      throw new Error('hosted_e2e_requires_root_for_image_lock_fixture');
    const appUid = 1000;
    const appGid = 1000;
    for (const appDataDir of [sandbox.appDataDir, sandbox.oidcAppDataDir]) {
      await run('node', ['--import', 'tsx', 'test/fixtures/hosted-v1/seedContainer.ts', 'seed'], {
        env: {
          ...sanitizedEnvironment,
          E2E_SEED_APP_DATA_ROOT: appDataDir,
          E2E_SEED_CLAUDE_ROOT: sandbox.claudeDir,
          E2E_SEED_MARKER_PATH: sandbox.markerPath,
        },
      });
      const dataDir = join(appDataDir, 'data');
      const lockDir = join(appDataDir, 'instance-lock');
      const lockPath = join(lockDir, 'instance.lock');
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await mkdir(lockDir, { recursive: true, mode: 0o555 });
      await writeFile(lockPath, '', { mode: 0o444 });
      await chown(appDataDir, 0, appGid);
      await chmod(appDataDir, 0o1770);
      await chown(lockDir, 0, 0);
      await chmod(lockDir, 0o555);
      await chown(lockPath, 0, 0);
      await chmod(lockPath, 0o444);
      for (const writable of [dataDir, join(appDataDir, 'storage'), join(appDataDir, 'logs')]) {
        await chownTree(writable, appUid, appGid);
        await chmod(writable, 0o700);
      }
    }
    await Promise.all(
      [
        sandbox.caddyDataDir,
        sandbox.claudeDir,
        sandbox.fakeRuntimeStateDir,
        sandbox.runDir,
        sandbox.workspaceDir,
      ].map((path) => chownTree(path, appUid, appGid))
    );

    const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!browserPath || !isAbsolute(browserPath)) {
      throw new Error('PLAYWRIGHT_BROWSERS_PATH must name the preinstalled Chromium cache');
    }
    const browserEnvironment: NodeJS.ProcessEnv = {
      ...sanitizedEnvironment,
      PLAYWRIGHT_BROWSERS_PATH: browserPath,
    };
    const eventCursor = encodeReplayCursor({
      deploymentId,
      eventEpoch: `epoch-initial-v1-${createHash('sha256').update(deploymentId).digest('hex').slice(0, 24)}`,
      eventSequence: 0,
    });

    const domain = 'hosted-v1-e2e.localhost';
    const oidcDomain = 'oidc-v1-e2e.localhost';
    const network = networkAddresses(sandbox.marker);
    const baseComposeEnv: NodeJS.ProcessEnv = {
      ...browserEnvironment,
      CADDY_IMAGE_DIGEST: caddyDigest,
      COMPOSE_FILE: composeFile,
      COMPOSE_PROJECT_NAME: composeProject,
      E2E_APP_GID: String(appGid),
      E2E_APP_IMAGE: `${composeProject}-app:latest`,
      E2E_APP_IP: network.app,
      E2E_APP_UID: String(appUid),
      E2E_CADDY_DATA_DIR: sandbox.caddyDataDir,
      E2E_CADDY_IP: network.caddy,
      E2E_CLAUDE_DIR: sandbox.claudeDir,
      E2E_BOOT_ID: `boot_hosted-v1-e2e-${sandbox.marker}`,
      E2E_FAKE_RUNTIME_STATE_DIR: sandbox.fakeRuntimeStateDir,
      E2E_LIFECYCLE_BOOTSTRAP: sandbox.bootstrap,
      E2E_NETWORK_SUBNET: network.subnet,
      E2E_OWNER_MARKER: sandbox.markerPath,
      E2E_RUN_DIR: sandbox.runDir,
      E2E_RUNTIME_WORKSPACE_ID,
      E2E_TEAM_RUNTIME_WORKSPACE_ID: E2E_WORKSPACE_ID,
      E2E_TEAM_ID,
      E2E_WORKSPACE_DIR: sandbox.workspaceDir,
      HOSTED_DOMAIN: domain,
      NODE_IMAGE_DIGEST: nodeDigest,
      KEYCLOAK_IMAGE_DIGEST: keycloakDigest,
      OIDC_DOMAIN: oidcDomain,
    };
    const composeArgs = ['compose', '--project-name', composeProject, '--file', composeFile];
    const authModes = ['personal', 'oidc', 'oidc-viewer'] as const;

    for (const [index, authMode] of authModes.entries()) {
      const createScenarioEnvironment = (port: number): NodeJS.ProcessEnv => {
        const origin = `https://${domain}:${port}`;
        return {
          ...baseComposeEnv,
          E2E_APP_DATA_DIR: authMode === 'personal' ? sandbox.appDataDir : sandbox.oidcAppDataDir,
          HOSTED_E2E_AUTH_MODE: authMode === 'personal' ? 'personal' : 'oidc',
          HOSTED_E2E_OIDC_ORIGIN: `https://${oidcDomain}:${port}`,
          HOSTED_E2E_OIDC_ROLE: authMode === 'oidc-viewer' ? 'viewer' : 'owner',
          HOSTED_E2E_ORIGIN: origin,
          HOSTED_HTTPS_PORT: String(port),
        };
      };
      let composeEnv = createScenarioEnvironment(1);
      let pairingCode: string | null = null;
      let scenarioError: unknown = null;
      let composeAttempted = false;
      let composeDown = false;
      try {
        composeAttempted = true;
        composeEnv = await runComposeUpWithExactBindRetry({
          ...(index === 0
            ? {
                buildImage: () =>
                  run('docker', [...composeArgs, 'build'], {
                    env: createScenarioEnvironment(1),
                  }).then(() => undefined),
              }
            : {}),
          cleanupBindCollision: async (failedEnvironment) => {
            await run(
              'docker',
              [...composeArgs, 'down', '--timeout', '30', '--volumes', '--remove-orphans'],
              { env: failedEnvironment }
            );
            const remaining = await run('docker', [...composeArgs, 'ps', '--all', '--quiet'], {
              env: failedEnvironment,
              capture: true,
            });
            assertNoComposeResourcesRemain(remaining);
          },
          createEnvironment: (port) => {
            composeEnv = createScenarioEnvironment(port);
            return composeEnv;
          },
          selectPort: availablePort,
          up: (environment) =>
            run('docker', [...composeArgs, 'up', '--no-build', '--detach', '--wait'], {
              env: environment,
              capture: true,
            }).then(() => undefined),
        });
        for (const [service, privatePort] of [
          ['hosted-controller', '3456'],
          ['synthetic-oidc', '8080'],
        ] as const) {
          const published = await run('docker', [...composeArgs, 'port', service, privatePort], {
            env: composeEnv,
            capture: true,
          });
          if (published !== '') throw new Error(`hosted_e2e_private_listener_published:${service}`);
        }
        if (authMode === 'personal') {
          pairingCode = await run(
            'docker',
            [
              ...composeArgs,
              'exec',
              '-T',
              'hosted-controller',
              'node',
              'scripts/hosted-auth-cli.mjs',
              'pairing-code',
            ],
            { env: composeEnv, capture: true }
          );
          if (!/^[A-Za-z0-9_-]{32,}$/.test(pairingCode)) {
            throw new Error('hosted_e2e_pairing_code_invalid');
          }
        }

        const runtimeFile = join(root, `runtime-${authMode}.json`);
        await writeFile(
          runtimeFile,
          `${JSON.stringify({
            authMode,
            composeFile,
            composeProject,
            eventCursor,
            fakeRuntimeStateFile: join(sandbox.fakeRuntimeStateDir, 'runtime-state.json'),
            origin: composeEnv.HOSTED_E2E_ORIGIN,
            pairingCode,
            runtimeWorkspaceId: E2E_RUNTIME_WORKSPACE_ID,
            teamId: E2E_TEAM_ID,
            teamName: E2E_TEAM_NAME,
            workspaceId: E2E_WORKSPACE_ID,
          })}\n`,
          { mode: 0o600 }
        );
        const outputDirectory = join(artifactDirectory, authMode, 'playwright');
        await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
        await run('pnpm', ['exec', 'playwright', 'test', '--config', playwrightConfig], {
          env: {
            ...composeEnv,
            HOSTED_E2E_RUNTIME_FILE: runtimeFile,
            HOSTED_E2E_OUTPUT_DIR: outputDirectory,
          },
        });
        await writeEvidence(
          join(artifactDirectory, authMode, 'result.json'),
          JSON.stringify({ schemaVersion: 1, authMode, status: 'passed' }, null, 2)
        );
      } catch (error) {
        scenarioError = error;
        await captureFailureEvidence({
          artifactDirectory,
          authMode,
          composeArgs,
          composeEnv,
          error,
          pairingCode,
          sandbox,
        });
      } finally {
        if (composeAttempted) {
          try {
            await run(
              'docker',
              [...composeArgs, 'down', '--timeout', '30', '--volumes', '--remove-orphans'],
              { env: composeEnv }
            );
            const remaining = await run('docker', [...composeArgs, 'ps', '--all', '--quiet'], {
              env: composeEnv,
              capture: true,
            });
            assertNoComposeResourcesRemain(remaining);
            composeDown = true;
          } catch (cleanupError) {
            rootRemovable = false;
            scenarioError = new AggregateError(
              [scenarioError, cleanupError].filter((value) => value !== null),
              'hosted_e2e_compose_cleanup_failed'
            );
            await captureFailureEvidence({
              artifactDirectory,
              authMode,
              composeArgs,
              composeEnv,
              error: scenarioError,
              pairingCode,
              sandbox,
            });
          }
        }
        if (composeDown && (scenarioError !== null || index === authModes.length - 1)) {
          try {
            await run('docker', ['image', 'rm', String(composeEnv.E2E_APP_IMAGE)], {
              env: composeEnv,
            });
          } catch (cleanupError) {
            scenarioError = new AggregateError(
              [scenarioError, cleanupError].filter((value) => value !== null),
              'hosted_e2e_image_cleanup_failed'
            );
            await captureFailureEvidence({
              artifactDirectory,
              authMode,
              composeArgs,
              composeEnv,
              error: scenarioError,
              pairingCode,
              sandbox,
            });
          }
        }
      }
      if (scenarioError !== null) {
        throw new Error(
          `hosted_e2e_${authMode}_failed; evidence retained at ${artifactDirectory}`,
          { cause: scenarioError }
        );
      }
    }
    await writeEvidence(
      join(artifactDirectory, 'result.json'),
      JSON.stringify(
        { schemaVersion: 1, status: 'passed', authModes: [...authModes], composeProject },
        null,
        2
      )
    );
  } catch (error) {
    await writeEvidence(
      join(artifactDirectory, 'runner-failure.json'),
      JSON.stringify({ schemaVersion: 1, status: 'failed', error: safeError(error) }, null, 2)
    ).catch(() => undefined);
    throw error;
  } finally {
    await assertHostedV1MarkerOwnedRoot(sandbox.root, sandbox.markerPath, sandbox.marker);
    if (rootRemovable) {
      await rm(sandbox.root, { recursive: true });
    } else {
      await writeEvidence(
        join(artifactDirectory, 'leftovers.json'),
        JSON.stringify(
          {
            schemaVersion: 1,
            status: 'cleanup_failed',
            marker: sandbox.marker,
            sandboxRoot: sandbox.root,
          },
          null,
          2
        )
      );
    }
    if (artifactOwner !== null) {
      await chownTree(artifactDirectory, artifactOwner.uid, artifactOwner.gid);
    }
  }
  process.stdout.write(`Hosted v1 E2E evidence: ${artifactDirectory}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
