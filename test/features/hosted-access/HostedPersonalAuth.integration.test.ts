import { spawn } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm as remove,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { rebuild } from '@electron/rebuild';
import {
  createHostedAccessFeature,
  type CreateHostedAccessFeatureDependencies,
} from '@features/hosted-access/main';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';
import Fastify from 'fastify';
import { build as buildVite } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type {
  HostedAuthStorageGateway,
  HostedAuthStorageOperation,
} from '@features/internal-storage/contracts';
import type { FastifyInstance } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';

function hostPlatform(): CreateHostedAccessFeatureDependencies['hostPlatform'] {
  return {
    uid: process.getuid?.(),
    pid: process.pid,
    join,
    dirname,
    isAbsolute,
    byteLength: Buffer.byteLength,
    mkdir: async (path, mode) => {
      await mkdir(path, { recursive: true, mode });
    },
    lstat,
    openReadOnlyNoFollow: async (path) => {
      const handle = await open(path, 'r');
      return {
        stat: () => handle.stat(),
        readTextBounded: async (maximumBytes) => {
          const stat = await handle.stat();
          if (stat.size > maximumBytes) throw new Error('test_secret_too_large');
          return handle.readFile('utf8');
        },
        close: () => handle.close(),
      };
    },
    chmod,
    writeTextDurable: async (path, body, options) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(path, options.exclusive ? 'wx' : 'w', options.mode);
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    rename,
    remove,
    randomBytes,
    base64UrlEncode: (bytes) => Buffer.from(bytes).toString('base64url'),
    base64UrlDecode: (value) => Buffer.from(value, 'base64url'),
    hmacSha256: (key, parts, encoding) => {
      const hmac = createHmac('sha256', key);
      for (const part of parts) hmac.update(part);
      return hmac.digest(encoding);
    },
    hkdfSha256: (input, salt, info, length) =>
      new Uint8Array(hkdfSync('sha256', input, salt, Buffer.from(info), length)),
    sha256Base64Url: (value) => createHash('sha256').update(value).digest('base64url'),
    verifyOidcSignature: () => false,
    encryptAes256Gcm: (input) => {
      const cipher = createCipheriv('aes-256-gcm', input.key, input.nonce);
      cipher.setAAD(Buffer.from(input.aad));
      return {
        ciphertext: Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]),
        tag: cipher.getAuthTag(),
      };
    },
    decryptAes256Gcm: (input) => {
      const decipher = createDecipheriv('aes-256-gcm', input.key, input.nonce);
      decipher.setAAD(Buffer.from(input.aad));
      decipher.setAuthTag(Buffer.from(input.tag));
      return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]).toString('utf8');
    },
    secureEqual: (left, right) => {
      const leftBytes = Buffer.from(left);
      const rightBytes = Buffer.from(right);
      return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
    },
  };
}

const unusedLocalControlTransport: CreateHostedAccessFeatureDependencies['localControlTransportFactory'] =
  {
    create: () => ({
      start: () => Promise.resolve(undefined),
      close: () => Promise.resolve(undefined),
    }),
  };

const directories: string[] = [];
const cores: InternalStorageWorkerCore[] = [];
const apps: FastifyInstance[] = [];

class SyntheticHostedAuthStorage implements HostedAuthStorageGateway {
  private mode: string | null = null;
  private authority: {
    readonly stateJson: string;
    readonly revision: number;
    readonly rollbackFenceRevision: number;
  } | null = null;
  private personalOwner: Record<string, unknown> | null = null;
  private readonly workspaces = new Map<string, Record<string, unknown>>();
  private readonly workspaceGrants = new Map<string, Record<string, unknown>>();
  private authorityStorageUnavailable = false;
  private identityStorageUnavailable = false;
  readonly audits: Record<string, unknown>[] = [];

  disableOwner(): void {
    if (this.personalOwner === null) throw new Error('synthetic_personal_owner_missing');
    const user = this.personalOwner.user as Record<string, unknown>;
    this.personalOwner = {
      ...this.personalOwner,
      user: { ...user, status: 'disabled', updatedAt: Date.now() },
    };
  }

  failIdentityStorage(): void {
    this.identityStorageUnavailable = true;
  }

  failAuthorityStorage(): void {
    this.authorityStorageUnavailable = true;
  }

  mismatchOwnerBinding(): void {
    if (this.personalOwner === null) throw new Error('synthetic_personal_owner_missing');
    this.personalOwner = {
      ...this.personalOwner,
      operatorId: 'operator_mismatched-owner-1234',
    };
  }

  hostedAuthCall(operation: HostedAuthStorageOperation, payloadValue: unknown): Promise<unknown> {
    const payload = payloadValue as Record<string, unknown>;
    switch (operation) {
      case 'configuration.claimMode': {
        this.mode ??= String(payload.mode);
        return Promise.resolve(this.mode === payload.mode);
      }
      case 'configuration.read':
        return Promise.resolve({
          authMode: this.mode,
          configuredAt: 1,
          resetGeneration: 0,
          secretsRotatedGeneration: 0,
          pendingPersonalKeyringId: null,
        });
      case 'authority.load':
        if (this.authorityStorageUnavailable) {
          throw new Error('synthetic_authority_storage_unavailable');
        }
        return Promise.resolve(this.authority);
      case 'authority.initialize':
        if (this.authority !== null) return Promise.resolve('conflict');
        this.authority = {
          stateJson: String(payload.stateJson),
          revision: Number(payload.revision),
          rollbackFenceRevision: Number(payload.revision),
        };
        return Promise.resolve('committed');
      case 'authority.compareAndSwap': {
        if (
          this.authority === null ||
          this.authority.revision !== payload.expectedRevision ||
          this.authority.rollbackFenceRevision !== payload.expectedRollbackFenceRevision
        ) {
          return Promise.resolve('conflict');
        }
        const nextRevision = Number(payload.nextRollbackFenceRevision);
        this.authority = {
          stateJson: String(payload.stateJson),
          revision: nextRevision,
          rollbackFenceRevision: nextRevision,
        };
        return Promise.resolve('committed');
      }
      case 'personal.ensureOwner':
        if (this.identityStorageUnavailable) {
          throw new Error('synthetic_identity_storage_unavailable');
        }
        this.personalOwner ??= {
          operatorId: payload.operatorId,
          user: payload.user,
        };
        return Promise.resolve(this.personalOwner);
      case 'workspace.seed':
        this.workspaces.set(String(payload.runtimeWorkspaceId), {
          runtimeWorkspaceId: payload.runtimeWorkspaceId,
          workspaceId: payload.workspaceId,
          displayName: payload.displayName,
          status: 'active',
          registeredAt: payload.registeredAt,
          registeredBy: null,
        });
        return Promise.resolve(null);
      case 'workspace.isRegistered':
        return Promise.resolve(
          this.workspaces.get(String(payload.runtimeWorkspaceId))?.status === 'active'
        );
      case 'workspace.list':
        return Promise.resolve([...this.workspaces.values()]);
      case 'workspace.grant.list':
        return Promise.resolve(
          [...this.workspaceGrants.values()].filter(
            (grant) =>
              grant.userId === payload.userId && grant.grantGeneration === payload.grantGeneration
          )
        );
      case 'workspace.grant.set': {
        const workspace = this.workspaces.get(String(payload.runtimeWorkspaceId));
        if (!workspace) throw new Error('hosted-workspace-not-registered');
        const grant = { ...workspace, ...payload };
        this.workspaceGrants.set(
          `${String(payload.userId)}\0${String(payload.runtimeWorkspaceId)}`,
          grant
        );
        return Promise.resolve(grant);
      }
      case 'workspace.grant.revoke':
        return Promise.resolve(
          this.workspaceGrants.delete(
            `${String(payload.userId)}\0${String(payload.runtimeWorkspaceId)}`
          )
        );
      case 'audit.append':
        this.audits.push(payload.event as Record<string, unknown>);
        return Promise.resolve(null);
      default:
        throw new Error(`unexpected_synthetic_storage_operation:${operation}`);
    }
  }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const core of cores.splice(0)) core.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function cookies(response: { headers: OutgoingHttpHeaders }): string[] {
  const value = response.headers['set-cookie'];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
}

function cookieValue(setCookies: readonly string[], name: string): string {
  const prefix = `${name}=`;
  const value = setCookies
    .map((entry) => entry.split(';', 1)[0] ?? '')
    .find((entry) => entry.startsWith(prefix));
  if (!value) throw new Error(`cookie ${name} not found`);
  return value.slice(prefix.length);
}

function storageHarness(directory: string): HostedAuthStorageGateway {
  const core = new InternalStorageWorkerCore({
    databasePath: join(directory, 'internal.sqlite'),
    createDatabase: (path, options) => new Database(path, options),
  });
  cores.push(core);
  return {
    hostedAuthCall: (operation: HostedAuthStorageOperation, payload: unknown) =>
      Promise.resolve(core.handle('hostedAuth.call', { operation, payload })),
  };
}

async function featureHarness(
  directory: string,
  storage: HostedAuthStorageGateway,
  options: {
    readonly publicOrigin?: string;
    readonly allowInsecureHttpForTests?: boolean;
  } = {}
) {
  const pairingPath = join(directory, 'pairing.json');
  const allowInsecureHttpForTests = options.allowInsecureHttpForTests ?? true;
  const feature = await createHostedAccessFeature({
    environment: {
      NODE_ENV: 'test',
      ...(allowInsecureHttpForTests ? { AUTH_ALLOW_INSECURE_HTTP_FOR_TESTS: '1' } : {}),
      AUTH_MODE: 'personal',
      AUTH_PUBLIC_ORIGIN: options.publicOrigin ?? 'http://agent-teams.test',
      AUTH_DEPLOYMENT_ID: 'deployment_synthetic-1',
      AUTH_RESTORE_GENERATION: '0',
      AUTH_IDENTITY_KEY_FILE: join(directory, 'secrets', 'identity.key'),
      AUTH_KEYRING_FILE: join(directory, 'secrets', 'personal-keyring.json'),
      PAIRING_CODE_FILE: pairingPath,
      HOSTED_WORKSPACE_IDS: 'project_synthetic-1',
    },
    storage,
    dataDirectory: directory,
    hostPlatform: hostPlatform(),
    localControlTransportFactory: unusedLocalControlTransport,
    drainProof: {
      confirmDrained: ({ purpose, resetGeneration }) =>
        Promise.resolve({
          status: 'drained',
          evidenceRef: `synthetic:${purpose}:${resetGeneration}`,
        }),
    },
    runWithBrowserStreamsDrained: (operation) => operation(),
    now: Date.now,
  });
  return { feature, pairingPath };
}

const electronBrowserE2eBinary = process.env.HOSTED_BROWSER_E2E_ELECTRON?.trim();
const ELECTRON_VERSION = '40.10.0';
const ELECTRON_MODULE_ABI = 143;
const NODE_MODULE_ABI = '137';
const workspaceRequire = createRequire(import.meta.url);
const electronNativeDirectories: string[] = [];
let electronNativeModuleAnchor: string | undefined;
const ELECTRON_NATIVE_ROOT_PACKAGES = ['better-sqlite3', 'node-pty', 'ssh2'] as const;
const ELECTRON_NATIVE_PACKAGES = new Set([
  ...ELECTRON_NATIVE_ROOT_PACKAGES,
  'asn1',
  'bcrypt-pbkdf',
  'bindings',
  'cpu-features',
  'file-uri-to-path',
  'nan',
  'node-addon-api',
  'safer-buffer',
  'tweetnacl',
]);

interface NativePackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

interface CopiedNativePackage {
  readonly version: string;
  readonly sourceDirectory: string;
}

function packageManifestPath(packageName: string, resolver: NodeJS.Require): string {
  try {
    return resolver.resolve(`${packageName}/package.json`);
  } catch {
    let cursor = dirname(resolver.resolve(packageName));
    while (true) {
      try {
        const candidate = join(cursor, 'package.json');
        const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as {
          readonly name?: unknown;
        };
        if (manifest.name === packageName) return candidate;
      } catch {
        // Keep walking from an exported entrypoint to its package root.
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    throw new Error(`hosted_electron_native_package_manifest_missing:${packageName}`);
  }
}

async function copyNativePackage(
  packageName: string,
  resolver: NodeJS.Require,
  isolatedRoot: string,
  copied: Map<string, CopiedNativePackage>,
  optional = false
): Promise<void> {
  if (!ELECTRON_NATIVE_PACKAGES.has(packageName)) return;
  let manifestPath: string;
  try {
    manifestPath = packageManifestPath(packageName, resolver);
  } catch (error) {
    if (optional) return;
    throw error;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as NativePackageManifest;
  const existing = copied.get(packageName);
  if (existing) {
    if (existing.version !== manifest.version) {
      throw new Error(`hosted_electron_native_package_version_conflict:${packageName}`);
    }
    return;
  }
  const sourceDirectory = dirname(manifestPath);
  const destination = join(isolatedRoot, 'node_modules', ...packageName.split('/'));
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(sourceDirectory, destination, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
  });
  copied.set(packageName, { version: manifest.version, sourceDirectory });
  const packageRequire = createRequire(manifestPath);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await copyNativePackage(dependency, packageRequire, isolatedRoot, copied);
  }
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
    await copyNativePackage(dependency, packageRequire, isolatedRoot, copied, true);
  }
}

async function nativeBindingFingerprints(
  copied: ReadonlyMap<string, CopiedNativePackage>
): Promise<ReadonlyMap<string, string>> {
  const fingerprints = new Map<string, string>();
  const visit = async (packageName: string, root: string, directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(packageName, root, path);
      } else if (entry.isFile() && entry.name.endsWith('.node')) {
        fingerprints.set(
          `${packageName}/${relative(root, path)}`,
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex')
        );
      }
    }
  };
  for (const packageName of ['better-sqlite3', 'node-pty', 'cpu-features']) {
    const packageValue = copied.get(packageName);
    if (packageValue) {
      await visit(packageName, packageValue.sourceDirectory, packageValue.sourceDirectory);
    }
  }
  return fingerprints;
}

async function removeCopiedNativeBindings(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await removeCopiedNativeBindings(path);
    } else if (entry.isFile() && entry.name.endsWith('.node')) {
      await remove(path);
    }
  }
}

function verifyWorkspaceNativeModules(): void {
  const WorkspaceDatabase = workspaceRequire('better-sqlite3') as typeof Database;
  const database = new WorkspaceDatabase(':memory:');
  const row = database.prepare('SELECT 1 AS value').get() as { readonly value?: unknown };
  database.close();
  const nodePty = workspaceRequire('node-pty') as { readonly spawn?: unknown };
  const ssh2 = workspaceRequire('ssh2') as { readonly Client?: unknown };
  if (row.value !== 1 || typeof nodePty.spawn !== 'function' || typeof ssh2.Client !== 'function') {
    throw new Error('hosted_workspace_node_native_module_probe_failed');
  }
}

async function prepareElectronNativeModuleTree(): Promise<string> {
  if (process.versions.modules !== NODE_MODULE_ABI) {
    throw new Error(`hosted_workspace_node_abi_unexpected:${process.versions.modules}`);
  }
  verifyWorkspaceNativeModules();
  const isolatedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'hosted-electron-native-abi-')));
  electronNativeDirectories.push(isolatedRoot);
  const copied = new Map<string, CopiedNativePackage>();
  for (const packageName of ELECTRON_NATIVE_ROOT_PACKAGES) {
    await copyNativePackage(packageName, workspaceRequire, isolatedRoot, copied);
  }
  const packageDependencies = Object.fromEntries(
    [...ELECTRON_NATIVE_ROOT_PACKAGES, 'cpu-features'].map((packageName) => {
      const packageValue = copied.get(packageName);
      if (!packageValue) throw new Error(`hosted_electron_native_package_missing:${packageName}`);
      return [packageName, packageValue.version];
    })
  );
  await writeFile(
    join(isolatedRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'hosted-electron-native-abi-proof',
        private: true,
        version: '1.0.0',
        dependencies: packageDependencies,
      },
      null,
      2
    )}\n`,
    { mode: 0o600, flag: 'wx' }
  );
  const workspaceFingerprints = await nativeBindingFingerprints(copied);
  if (workspaceFingerprints.size === 0) {
    throw new Error('hosted_workspace_native_binding_fingerprints_missing');
  }
  await removeCopiedNativeBindings(join(isolatedRoot, 'node_modules'));
  await rebuild({
    buildPath: isolatedRoot,
    electronVersion: ELECTRON_VERSION,
    arch: process.arch,
    platform: process.platform,
    onlyModules: [...ELECTRON_NATIVE_ROOT_PACKAGES, 'cpu-features'],
    force: true,
    forceABI: ELECTRON_MODULE_ABI,
    buildFromSource: true,
    mode: 'sequential',
  });
  const workspaceFingerprintsAfter = await nativeBindingFingerprints(copied);
  if (
    JSON.stringify([...workspaceFingerprints]) !== JSON.stringify([...workspaceFingerprintsAfter])
  ) {
    throw new Error('hosted_workspace_native_dependencies_were_mutated');
  }
  verifyWorkspaceNativeModules();
  return join(isolatedRoot, 'package.json');
}

beforeAll(async () => {
  if (electronBrowserE2eBinary) {
    electronNativeModuleAnchor = await prepareElectronNativeModuleTree();
  }
}, 300_000);

afterAll(() => {
  for (const directory of electronNativeDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const ELECTRON_BROWSER_RESULT_PREFIX = 'HOSTED_BROWSER_RESULT:';
const ELECTRON_BROWSER_PROBE_SOURCE = String.raw`
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { app, session, webContents } = require('electron');

const input = JSON.parse(readFileSync(0, 'utf8'));
const SESSION_COOKIE = '__Host-agent-teams-session';
const DEVICE_COOKIE = '__Host-agent-teams-device';
const completedRequests = [];

function names(cookies) {
  return cookies.map((cookie) => cookie.name).sort();
}

function cookiePolicy(cookies) {
  return cookies.every(
    (cookie) =>
      cookie.hostOnly === true &&
      cookie.path === '/' &&
      cookie.secure === true &&
      cookie.httpOnly === true &&
      cookie.session === false &&
      cookie.sameSite === 'strict' &&
      typeof cookie.expirationDate === 'number'
  );
}

function verifyNativeModules() {
  const runtimeRequire = createRequire(input.moduleAnchor);
  const Database = runtimeRequire('better-sqlite3');
  const database = new Database(':memory:');
  const sqliteRow = database.prepare('SELECT 1 AS value').get();
  database.close();
  const nodePty = runtimeRequire('node-pty');
  const ssh2 = runtimeRequire('ssh2');
  if (
    sqliteRow?.value !== 1 ||
    typeof nodePty.spawn !== 'function' ||
    typeof ssh2.Client !== 'function'
  ) {
    throw new Error('electron_native_module_probe_failed');
  }
  return {
    loaded: ['better-sqlite3', 'node-pty', 'ssh2'],
    electronVersion: process.versions.electron,
    moduleAbi: Number(process.versions.modules),
  };
}

async function request(path, options = {}) {
  const response = await session.defaultSession.fetch(input.baseUrl + path, {
    credentials: 'include',
    redirect: 'manual',
    ...options,
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body };
}

function mutationHeaders(csrfToken) {
  return {
    'content-type': 'application/json',
    ...(csrfToken === undefined ? {} : { 'x-agent-teams-csrf': csrfToken }),
  };
}

async function cookies() {
  return session.defaultSession.cookies.get({ url: input.baseUrl });
}

async function waitUntil(probe, code, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(code);
}

function completedCount(path) {
  return completedRequests.filter((request) => new URL(request.url).pathname === path).length;
}

function latestCompleted(path) {
  return completedRequests.findLast((request) => new URL(request.url).pathname === path);
}

async function pair(pairingCode) {
  return request('/api/auth/personal/pair', {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify({ pairingCode }),
  });
}

async function runPairLogout() {
  await session.defaultSession.cookies.set({
    url: input.baseUrl,
    name: SESSION_COOKIE,
    value: 'attacker-fixed-session',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'strict',
    expirationDate: Date.now() / 1000 + 900,
  });
  const paired = await pair(input.pairingCode);
  const pairedCookies = await cookies();
  const pairedSession = pairedCookies.find((cookie) => cookie.name === SESSION_COOKIE);
  const replay = await pair(input.pairingCode);
  const missingCsrf = await request('/api/config/pin-session', {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify({
      projectId: 'project_synthetic-1',
      sessionId: 'session-synthetic',
    }),
  });
  const command = await request('/api/config/pin-session', {
    method: 'POST',
    headers: mutationHeaders(paired.body?.csrfToken),
    body: JSON.stringify({
      projectId: 'project_synthetic-1',
      sessionId: 'session-synthetic',
    }),
  });
  const loggedOut = await request('/api/auth/logout', {
    method: 'POST',
    headers: mutationHeaders(paired.body?.csrfToken),
    body: JSON.stringify({ global: false }),
  });
  const afterLogout = await cookies();
  return {
    pairedStatus: paired.status,
    authenticated: paired.body?.authenticated === true,
    fixationResisted: pairedSession?.value !== 'attacker-fixed-session',
    pairedCookieNames: names(pairedCookies),
    pairedCookiePolicy: cookiePolicy(pairedCookies),
    replayStatus: replay.status,
    missingCsrfStatus: missingCsrf.status,
    commandStatus: command.status,
    logoutStatus: loggedOut.status,
    afterLogoutCookieNames: names(afterLogout),
    afterLogoutCookiePolicy: cookiePolicy(afterLogout),
  };
}

async function runRenewAfterRestart() {
  const before = await cookies();
  const beforeDevice = before.find((cookie) => cookie.name === DEVICE_COOKIE);
  const status = await request('/api/auth/status');
  const after = await cookies();
  const afterDevice = after.find((cookie) => cookie.name === DEVICE_COOKIE);
  return {
    beforeCookieNames: names(before),
    statusCode: status.status,
    authenticated: status.body?.authenticated === true,
    role: status.body?.principal?.role,
    afterCookieNames: names(after),
    renewedCookiePolicy: cookiePolicy(after),
    deviceRotated:
      typeof beforeDevice?.value === 'string' &&
      typeof afterDevice?.value === 'string' &&
      beforeDevice.value !== afterDevice.value,
  };
}

async function runResetRepairForget() {
  const rejectedAfterReset = await request('/api/auth/status');
  const repaired = await pair(input.pairingCode);
  const repairedCookies = await cookies();
  const forgotten = await request('/api/auth/personal/forget-device', {
    method: 'POST',
    headers: mutationHeaders(repaired.body?.csrfToken),
    body: '{}',
  });
  const afterForget = await cookies();
  return {
    resetRejectedOldCredentials: rejectedAfterReset.body?.authenticated === false,
    repairedStatus: repaired.status,
    repairedCookieNames: names(repairedCookies),
    repairedCookiePolicy: cookiePolicy(repairedCookies),
    forgetStatus: forgotten.status,
    afterForgetCookieNames: names(afterForget),
  };
}

async function runRenderedUi() {
  process.stderr.write('browser_probe_progress:rendered-ui-start\n');
  const browserContents = webContents.create({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  let finishedLoads = 0;
  browserContents.on('did-finish-load', () => {
    finishedLoads += 1;
  });
  await browserContents.loadURL(input.baseUrl + '/hosted-auth-ui');
  process.stderr.write('browser_probe_progress:rendered-ui-loaded\n');
  await waitUntil(
    () =>
      browserContents.executeJavaScript(
        "Boolean(document.querySelector('#hosted-pairing-code'))"
    ),
    'rendered_ui_pairing_form_missing'
  );
  process.stderr.write('browser_probe_progress:pairing-form-ready\n');
  const pairingCodeLiteral = JSON.stringify(input.pairingCode);
  const initial = await browserContents.executeJavaScript(
    [
      '(() => {',
      "  const pairingInput = document.querySelector('#hosted-pairing-code');",
      '  return {',
      "    heading: document.querySelector('h1')?.textContent ?? null,",
      "    inputType: pairingInput?.getAttribute('type') ?? null,",
      "    inputAutoComplete: pairingInput?.getAttribute('autocomplete') ?? null,",
      '    pairingCodeAbsentFromUrl: !location.href.includes(' + pairingCodeLiteral + '),',
      '    pairingCodeAbsentFromStorage:',
      '      !Object.values(localStorage).includes(' + pairingCodeLiteral + ') &&',
      '      !Object.values(sessionStorage).includes(' + pairingCodeLiteral + '),',
      '  };',
      '})()',
    ].join('\n')
  );
  await browserContents.executeJavaScript(
    [
      '(() => {',
      "  const pairingInput = document.querySelector('#hosted-pairing-code');",
      "  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;",
      '  if (!(pairingInput instanceof HTMLInputElement) || setter === undefined) {',
      "    throw new Error('rendered_ui_pairing_input_invalid');",
      '  }',
      '  setter.call(pairingInput, ' + pairingCodeLiteral + ');',
      "  pairingInput.dispatchEvent(new Event('input', { bubbles: true }));",
      '})()',
    ].join('\n')
  );
  await browserContents.executeJavaScript(
    [
      '(() => {',
      "  const pairButton = [...document.querySelectorAll('button')].find(",
      "    (candidate) => candidate.textContent?.trim() === 'Pair this browser'",
      '  );',
      '  if (!(pairButton instanceof HTMLButtonElement)) {',
      "    throw new Error('rendered_ui_pair_button_missing');",
      '  }',
      '  pairButton.click();',
      '})()',
    ].join('\n')
  );
  await waitUntil(
    () =>
      browserContents.executeJavaScript(
        "Boolean(document.querySelector('aside[aria-label=\"Hosted account\"]'))"
      ),
    'rendered_ui_authenticated_account_missing'
  );
  process.stderr.write('browser_probe_progress:authenticated\n');
  const authenticated = await browserContents.executeJavaScript(
    [
      '(() => ({',
      '  protectedContentVisible:',
      "    document.querySelector('#hosted-auth-protected-content')?.textContent ===",
      "    'Protected hosted content',",
      '  accountText:',
      "    document.querySelector('aside[aria-label=\"Hosted account\"]')?.textContent ?? '',",
      '  pairingCodeAbsentFromStorage:',
      '    !Object.values(localStorage).includes(' + pairingCodeLiteral + ') &&',
      '    !Object.values(sessionStorage).includes(' + pairingCodeLiteral + '),',
      '}))()',
    ].join('\n')
  );

  const logoutCount = completedCount('/api/auth/logout');
  const loadCountBeforeLogout = finishedLoads;
  await browserContents.executeJavaScript(
    [
      '(() => {',
      "  const signOut = [...document.querySelectorAll('button')].find(",
      "    (candidate) => candidate.textContent?.trim() === 'Sign out'",
      '  );',
      '  if (!(signOut instanceof HTMLButtonElement)) {',
      "    throw new Error('rendered_ui_sign_out_missing');",
      '  }',
      '  signOut.click();',
      '})()',
    ].join('\n')
  );
  await waitUntil(
    () => completedCount('/api/auth/logout') > logoutCount,
    'rendered_ui_logout_request_missing'
  );
  await waitUntil(
    () => finishedLoads > loadCountBeforeLogout,
    'rendered_ui_logout_reload_missing'
  );
  process.stderr.write('browser_probe_progress:logout-reloaded\n');
  await waitUntil(
    () =>
      browserContents.executeJavaScript(
        "Boolean(document.querySelector('aside[aria-label=\"Hosted account\"]'))"
      ),
    'rendered_ui_device_reauthentication_missing'
  );

  const forgetCount = completedCount('/api/auth/personal/forget-device');
  const loadCountBeforeForget = finishedLoads;
  await browserContents.executeJavaScript(
    [
      '(() => {',
      "  const forget = [...document.querySelectorAll('button')].find(",
      "    (candidate) => candidate.textContent?.trim() === 'Forget browser'",
      '  );',
      '  if (!(forget instanceof HTMLButtonElement)) {',
      "    throw new Error('rendered_ui_forget_browser_missing');",
      '  }',
      '  forget.click();',
      '})()',
    ].join('\n')
  );
  await waitUntil(
    () => completedCount('/api/auth/personal/forget-device') > forgetCount,
    'rendered_ui_forget_request_missing'
  );
  await waitUntil(
    () => finishedLoads > loadCountBeforeForget,
    'rendered_ui_forget_reload_missing'
  );
  process.stderr.write('browser_probe_progress:forget-reloaded\n');
  await waitUntil(
    () =>
      browserContents.executeJavaScript(
        "Boolean(document.querySelector('#hosted-pairing-code'))"
      ),
    'rendered_ui_anonymous_form_missing'
  );
  const finalState = await browserContents.executeJavaScript(
    [
      '(() => ({',
      "  anonymousPairingFormVisible: Boolean(document.querySelector('#hosted-pairing-code')),",
      "  protectedContentAbsent: !document.querySelector('#hosted-auth-protected-content'),",
      '  pairingCodeAbsentFromUrl: !location.href.includes(' + pairingCodeLiteral + '),',
      '  pairingCodeAbsentFromStorage:',
      '    !Object.values(localStorage).includes(' + pairingCodeLiteral + ') &&',
      '    !Object.values(sessionStorage).includes(' + pairingCodeLiteral + '),',
      '}))()',
    ].join('\n')
  );
  const finalCookies = await cookies();
  browserContents.close();
  return {
    initial,
    authenticated,
    logoutStatus: latestCompleted('/api/auth/logout')?.statusCode ?? null,
    reauthenticatedFromDeviceAfterLocalLogout: true,
    forgetStatus: latestCompleted('/api/auth/personal/forget-device')?.statusCode ?? null,
    finalState,
    finalCookieNames: names(finalCookies),
  };
}

async function main() {
  const nativeModules = verifyNativeModules();
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [input.baseUrl + '/*'] },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          Origin: input.publicOrigin,
          'Sec-Fetch-Site': 'same-origin',
        },
      });
    }
  );
  session.defaultSession.webRequest.onCompleted(
    { urls: [input.baseUrl + '/*'] },
    (details) => {
      completedRequests.push({
        method: details.method,
        statusCode: details.statusCode,
        url: details.url,
      });
    }
  );
  const phaseResult =
    input.phase === 'pair-logout'
      ? await runPairLogout()
      : input.phase === 'renew-after-restart'
        ? await runRenewAfterRestart()
        : input.phase === 'reset-repair-forget'
          ? await runResetRepairForget()
          : input.phase === 'rendered-ui'
            ? await runRenderedUi()
	          : (() => {
	              throw new Error('browser_probe_phase_invalid');
	            })();
  const result = { ...phaseResult, nativeModules };
  await session.defaultSession.cookies.flushStore();
  await new Promise((resolve) =>
    process.stdout.write(
      '${ELECTRON_BROWSER_RESULT_PREFIX}' + JSON.stringify(result) + '\n',
      resolve
    )
  );
}

app
  .whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error) => {
    process.stderr.write('browser_probe_failed:' + String(error?.message ?? error) + '\n');
    app.exit(1);
  });
`;

async function runElectronBrowserPhase(input: {
  readonly electronBinary: string;
  readonly scriptPath: string;
  readonly profileDirectory: string;
  readonly runtimeDirectory: string;
  readonly baseUrl: string;
  readonly publicOrigin: string;
  readonly phase: 'pair-logout' | 'renew-after-restart' | 'reset-repair-forget' | 'rendered-ui';
  readonly pairingCode?: string;
}): Promise<Record<string, unknown>> {
  if (!electronNativeModuleAnchor) {
    throw new Error('hosted_electron_native_module_anchor_missing');
  }
  await mkdir(input.runtimeDirectory, { recursive: true, mode: 0o700 });
  const electronArguments = [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${input.profileDirectory}`,
    input.scriptPath,
  ];
  const child = spawn(input.electronBinary, electronArguments, {
    env: {
      LANG: process.env.LANG ?? 'C.UTF-8',
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
      TMPDIR: input.runtimeDirectory,
      XDG_CACHE_HOME: join(input.runtimeDirectory, 'cache'),
      XDG_CONFIG_HOME: join(input.runtimeDirectory, 'config'),
      XDG_RUNTIME_DIR: input.runtimeDirectory,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-1_000_000);
  });
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-32_000);
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(
    JSON.stringify({
      baseUrl: input.baseUrl,
      publicOrigin: input.publicOrigin,
      moduleAnchor: electronNativeModuleAnchor,
      phase: input.phase,
      ...(input.pairingCode === undefined ? {} : { pairingCode: input.pairingCode }),
    })
  );
  const exit = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`hosted_browser_e2e_timeout:${stderr.slice(-8_000)}`));
    }, 45_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  if (exit.code !== 0) {
    throw new Error(
      `hosted_browser_e2e_failed:${exit.code}:${exit.signal ?? 'none'}:${stderr.slice(-8_000)}`
    );
  }
  const resultLine = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(ELECTRON_BROWSER_RESULT_PREFIX));
  if (resultLine === undefined) throw new Error('hosted_browser_e2e_result_missing');
  const result = JSON.parse(resultLine.slice(ELECTRON_BROWSER_RESULT_PREFIX.length)) as unknown;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('hosted_browser_e2e_result_invalid');
  }
  return result as Record<string, unknown>;
}

async function buildHostedAuthUiFixture(directory: string): Promise<{
  readonly html: string;
  readonly assets: ReadonlyMap<string, { readonly body: Buffer; readonly contentType: string }>;
}> {
  const sourceDirectory = join(directory, 'rendered-ui-source');
  const outputDirectory = join(directory, 'rendered-ui-dist');
  const assetsDirectory = join(outputDirectory, 'hosted-auth-assets');
  await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(sourceDirectory, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>',
    { mode: 0o600 }
  );
  await writeFile(
    join(sourceDirectory, 'entry.tsx'),
    `import React from 'react';
import { createRoot } from 'react-dom/client';
import { HostedAuthGate } from ${JSON.stringify(
      join(process.cwd(), 'src/features/hosted-access/renderer/HostedAuthGate.tsx')
    )};
const protectedContent = React.createElement(
  'div',
  { id: 'hosted-auth-protected-content' },
  'Protected hosted content'
);
createRoot(document.getElementById('root')).render(
  React.createElement(HostedAuthGate, null, protectedContent)
);
`,
    { mode: 0o600 }
  );
  await buildVite({
    configFile: false,
    root: sourceDirectory,
    logLevel: 'silent',
    resolve: {
      alias: {
        '@features': join(process.cwd(), 'src/features'),
        '@renderer': join(process.cwd(), 'src/renderer'),
        '@shared': join(process.cwd(), 'src/shared'),
        react: join(process.cwd(), 'node_modules/react'),
        'react-dom': join(process.cwd(), 'node_modules/react-dom'),
      },
    },
    build: {
      assetsDir: 'hosted-auth-assets',
      emptyOutDir: true,
      minify: false,
      outDir: outputDirectory,
      sourcemap: false,
      target: 'chrome138',
    },
  });
  const assets = new Map<string, { readonly body: Buffer; readonly contentType: string }>();
  for (const assetName of await readdir(assetsDirectory)) {
    assets.set(assetName, {
      body: await readFile(join(assetsDirectory, assetName)),
      contentType: assetName.endsWith('.css') ? 'text/css' : 'text/javascript',
    });
  }
  return {
    html: await readFile(join(outputDirectory, 'index.html'), 'utf8'),
    assets,
  };
}

describe('personal hosted authentication synthetic sandbox E2E', () => {
  it.runIf(electronBrowserE2eBinary !== undefined)(
    'renders pairing, local logout and forget-device through HostedAuthGate in Chromium',
    async () => {
      const electronBinary = electronBrowserE2eBinary!;
      const directory = mkdtempSync(join(tmpdir(), 'hosted-personal-rendered-e2e-'));
      directories.push(directory);
      const storage = storageHarness(directory);
      const publicOrigin = 'https://localhost';
      const { feature, pairingPath } = await featureHarness(directory, storage, {
        publicOrigin,
        allowInsecureHttpForTests: false,
      });
      const delivery = JSON.parse(readFileSync(pairingPath, 'utf8')) as {
        readonly pairingCode: string;
      };
      const fixture = await buildHostedAuthUiFixture(directory);
      const app = Fastify();
      apps.push(app);
      feature.http.register(app);
      app.get('/hosted-auth-ui', async (_request, reply) =>
        reply.type('text/html; charset=utf-8').send(fixture.html)
      );
      for (const [assetName, asset] of fixture.assets) {
        app.get(`/hosted-auth-assets/${assetName}`, async (_request, reply) =>
          reply.type(asset.contentType).send(asset.body)
        );
      }
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('hosted_rendered_e2e_address_unavailable');
      }
      const baseUrl = `http://localhost:${address.port}`;
      const scriptPath = join(directory, 'electron-hosted-rendered-e2e.cjs');
      const browserScratch = realpathSync(
        mkdtempSync(join(dirname(tmpdir()), 'hosted-rendered-e2e-'))
      );
      directories.push(browserScratch);
      await writeFile(scriptPath, ELECTRON_BROWSER_PROBE_SOURCE, { mode: 0o600 });

      const result = await runElectronBrowserPhase({
        electronBinary,
        scriptPath,
        profileDirectory: join(browserScratch, 'profile'),
        runtimeDirectory: join(browserScratch, 'runtime'),
        baseUrl,
        publicOrigin,
        phase: 'rendered-ui',
        pairingCode: delivery.pairingCode,
      });
      expect(result).toEqual({
        initial: {
          heading: 'Sign in to this deployment',
          inputType: 'password',
          inputAutoComplete: 'one-time-code',
          pairingCodeAbsentFromUrl: true,
          pairingCodeAbsentFromStorage: true,
        },
        authenticated: {
          protectedContentVisible: true,
          accountText: expect.stringContaining('Personal owner'),
          pairingCodeAbsentFromStorage: true,
        },
        logoutStatus: 200,
        reauthenticatedFromDeviceAfterLocalLogout: true,
        forgetStatus: 200,
        finalState: {
          anonymousPairingFormVisible: true,
          protectedContentAbsent: true,
          pairingCodeAbsentFromUrl: true,
          pairingCodeAbsentFromStorage: true,
        },
        finalCookieNames: [],
        nativeModules: {
          loaded: ['better-sqlite3', 'node-pty', 'ssh2'],
          electronVersion: ELECTRON_VERSION,
          moduleAbi: ELECTRON_MODULE_ABI,
        },
      });
      expect(JSON.stringify(result)).not.toContain(delivery.pairingCode);
    },
    120_000
  );

  it.runIf(electronBrowserE2eBinary !== undefined)(
    'persists and rotates production cookies in Chromium across restart, reset and forget-device',
    async () => {
      const electronBinary = electronBrowserE2eBinary!;
      const electronStat = await lstat(electronBinary);
      expect(electronStat.isFile()).toBe(true);
      expect(electronStat.mode & 0o111).not.toBe(0);

      const directory = mkdtempSync(join(tmpdir(), 'hosted-personal-browser-e2e-'));
      directories.push(directory);
      const storage = storageHarness(directory);
      const publicOrigin = 'https://localhost';
      const { feature, pairingPath } = await featureHarness(directory, storage, {
        publicOrigin,
        allowInsecureHttpForTests: false,
      });
      const initialDelivery = JSON.parse(readFileSync(pairingPath, 'utf8')) as {
        readonly pairingCode: string;
      };
      const app = Fastify();
      apps.push(app);
      feature.http.register(app);
      app.post('/api/config/pin-session', () => ({ ok: true }));
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('hosted_browser_e2e_address_unavailable');
      }
      const baseUrl = `http://localhost:${address.port}`;
      const scriptPath = join(directory, 'electron-hosted-browser-e2e.cjs');
      const browserScratch = realpathSync(
        mkdtempSync(join(dirname(tmpdir()), 'hosted-browser-e2e-'))
      );
      directories.push(browserScratch);
      const profileDirectory = join(browserScratch, 'profile');
      await writeFile(scriptPath, ELECTRON_BROWSER_PROBE_SOURCE, { mode: 0o600 });

      const pairLogout = await runElectronBrowserPhase({
        electronBinary,
        scriptPath,
        profileDirectory,
        runtimeDirectory: join(browserScratch, 'runtime-pair'),
        baseUrl,
        publicOrigin,
        phase: 'pair-logout',
        pairingCode: initialDelivery.pairingCode,
      });
      expect(pairLogout).toEqual({
        pairedStatus: 200,
        authenticated: true,
        fixationResisted: true,
        pairedCookieNames: ['__Host-agent-teams-device', '__Host-agent-teams-session'],
        pairedCookiePolicy: true,
        replayStatus: 401,
        missingCsrfStatus: 403,
        commandStatus: 200,
        logoutStatus: 200,
        afterLogoutCookieNames: ['__Host-agent-teams-device'],
        afterLogoutCookiePolicy: true,
        nativeModules: {
          loaded: ['better-sqlite3', 'node-pty', 'ssh2'],
          electronVersion: ELECTRON_VERSION,
          moduleAbi: ELECTRON_MODULE_ABI,
        },
      });
      expect(JSON.stringify(pairLogout)).not.toContain(initialDelivery.pairingCode);

      const renewed = await runElectronBrowserPhase({
        electronBinary,
        scriptPath,
        profileDirectory,
        runtimeDirectory: join(browserScratch, 'runtime-renew'),
        baseUrl,
        publicOrigin,
        phase: 'renew-after-restart',
      });
      expect(renewed).toEqual({
        beforeCookieNames: ['__Host-agent-teams-device'],
        statusCode: 200,
        authenticated: true,
        role: 'owner',
        afterCookieNames: ['__Host-agent-teams-device', '__Host-agent-teams-session'],
        renewedCookiePolicy: true,
        deviceRotated: true,
        nativeModules: {
          loaded: ['better-sqlite3', 'node-pty', 'ssh2'],
          electronVersion: ELECTRON_VERSION,
          moduleAbi: ELECTRON_MODULE_ABI,
        },
      });

      await expect(feature.localAdministration.resetPersonal(1)).resolves.toEqual({
        resetGeneration: 1,
      });
      const resetDelivery = JSON.parse(readFileSync(pairingPath, 'utf8')) as {
        readonly pairingCode: string;
      };
      expect(resetDelivery.pairingCode).not.toBe(initialDelivery.pairingCode);

      const repaired = await runElectronBrowserPhase({
        electronBinary,
        scriptPath,
        profileDirectory,
        runtimeDirectory: join(browserScratch, 'runtime-repair'),
        baseUrl,
        publicOrigin,
        phase: 'reset-repair-forget',
        pairingCode: resetDelivery.pairingCode,
      });
      expect(repaired).toEqual({
        resetRejectedOldCredentials: true,
        repairedStatus: 200,
        repairedCookieNames: ['__Host-agent-teams-device', '__Host-agent-teams-session'],
        repairedCookiePolicy: true,
        forgetStatus: 200,
        afterForgetCookieNames: [],
        nativeModules: {
          loaded: ['better-sqlite3', 'node-pty', 'ssh2'],
          electronVersion: ELECTRON_VERSION,
          moduleAbi: ELECTRON_MODULE_ABI,
        },
      });
      expect(JSON.stringify(repaired)).not.toContain(resetDelivery.pairingCode);
    },
    120_000
  );

  it('reports an identity-storage outage without discarding a valid session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hosted-personal-storage-outage-e2e-'));
    directories.push(directory);
    const storage = new SyntheticHostedAuthStorage();
    const { feature, pairingPath } = await featureHarness(directory, storage);
    const delivery = JSON.parse(readFileSync(pairingPath, 'utf8')) as {
      pairingCode: string;
    };
    const app = Fastify();
    apps.push(app);
    feature.http.register(app);

    const paired = await app.inject({
      method: 'POST',
      url: '/api/auth/personal/pair',
      headers: {
        origin: 'http://agent-teams.test',
        'sec-fetch-site': 'same-origin',
      },
      payload: { pairingCode: delivery.pairingCode },
    });
    const session = cookieValue(cookies(paired), '__Host-agent-teams-session');
    storage.failIdentityStorage();

    const unavailable = await app.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { cookie: `__Host-agent-teams-session=${session}` },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ error: 'identity_storage_unavailable' });
    expect(cookies(unavailable)).toEqual([]);
  });

  it('reports an authority-storage outage without discarding or renewing credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hosted-personal-authority-outage-e2e-'));
    directories.push(directory);
    const storage = new SyntheticHostedAuthStorage();
    const { feature, pairingPath } = await featureHarness(directory, storage);
    const delivery = JSON.parse(readFileSync(pairingPath, 'utf8')) as {
      pairingCode: string;
    };
    const app = Fastify();
    apps.push(app);
    feature.http.register(app);

    const paired = await app.inject({
      method: 'POST',
      url: '/api/auth/personal/pair',
      headers: {
        origin: 'http://agent-teams.test',
        'sec-fetch-site': 'same-origin',
      },
      payload: { pairingCode: delivery.pairingCode },
    });
    const setCookies = cookies(paired);
    const session = cookieValue(setCookies, '__Host-agent-teams-session');
    const device = cookieValue(setCookies, '__Host-agent-teams-device');
    storage.failAuthorityStorage();

    for (const credential of [
      `__Host-agent-teams-session=${session}`,
      `__Host-agent-teams-device=${device}`,
    ]) {
      const unavailable = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
        headers: { cookie: credential },
      });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({ error: 'identity_storage_unavailable' });
      expect(cookies(unavailable)).toEqual([]);
    }
  });

  it('fails closed for both an active session and device renewal after owner disable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hosted-personal-disable-e2e-'));
    directories.push(directory);
    const storage = new SyntheticHostedAuthStorage();
    const { feature, pairingPath } = await featureHarness(directory, storage);
    const delivery = JSON.parse(readFileSync(pairingPath, 'utf8')) as {
      pairingCode: string;
    };
    const app = Fastify();
    apps.push(app);
    feature.http.register(app);

    const paired = await app.inject({
      method: 'POST',
      url: '/api/auth/personal/pair',
      headers: {
        origin: 'http://agent-teams.test',
        'sec-fetch-site': 'same-origin',
      },
      payload: { pairingCode: delivery.pairingCode },
    });
    const setCookies = cookies(paired);
    const session = cookieValue(setCookies, '__Host-agent-teams-session');
    const device = cookieValue(setCookies, '__Host-agent-teams-device');
    storage.disableOwner();

    const deniedSession = await app.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { cookie: `__Host-agent-teams-session=${session}` },
    });
    expect(deniedSession.json()).toMatchObject({
      authenticated: false,
      mode: 'personal',
    });

    const deniedRenewal = await app.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { cookie: `__Host-agent-teams-device=${device}` },
    });
    expect(deniedRenewal.json()).toMatchObject({
      authenticated: false,
      mode: 'personal',
    });
    expect(cookies(deniedRenewal)).toEqual([]);
  });

  it('fails unavailable instead of crossing a mismatched authority/identity owner binding', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hosted-personal-binding-mismatch-e2e-'));
    directories.push(directory);
    const storage = new SyntheticHostedAuthStorage();
    const { feature, pairingPath } = await featureHarness(directory, storage);
    const delivery = JSON.parse(readFileSync(pairingPath, 'utf8')) as {
      pairingCode: string;
    };
    const app = Fastify();
    apps.push(app);
    feature.http.register(app);

    const paired = await app.inject({
      method: 'POST',
      url: '/api/auth/personal/pair',
      headers: {
        origin: 'http://agent-teams.test',
        'sec-fetch-site': 'same-origin',
      },
      payload: { pairingCode: delivery.pairingCode },
    });
    const setCookies = cookies(paired);
    const session = cookieValue(setCookies, '__Host-agent-teams-session');
    const device = cookieValue(setCookies, '__Host-agent-teams-device');
    storage.mismatchOwnerBinding();

    for (const credential of [
      `__Host-agent-teams-session=${session}`,
      `__Host-agent-teams-device=${device}`,
    ]) {
      const unavailable = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
        headers: { cookie: credential },
      });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({ error: 'identity_storage_unavailable' });
      expect(cookies(unavailable)).toEqual([]);
    }
  });

  it('pairs, restarts, resets, forgets a device and resists fixation/replay/CSRF', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hosted-personal-e2e-'));
    directories.push(directory);
    const storage = storageHarness(directory);
    const { feature, pairingPath } = await featureHarness(directory, storage);
    const delivery = JSON.parse(readFileSync(pairingPath, 'utf8')) as {
      pairingCode: string;
      expiresAt: number;
    };
    const originalKeyring = JSON.parse(
      readFileSync(join(directory, 'secrets', 'personal-keyring.json'), 'utf8')
    ) as { keyringId: string };
    expect(delivery.pairingCode).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(delivery.expiresAt).toBeGreaterThan(Date.now());

    const app = Fastify();
    apps.push(app);
    feature.http.register(app);
    app.post('/api/config/pin-session', () => ({ ok: true }));

    const paired = await app.inject({
      method: 'POST',
      url: '/api/auth/personal/pair',
      headers: {
        origin: 'http://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        cookie: '__Host-agent-teams-session=attacker-fixed-session',
      },
      payload: { pairingCode: delivery.pairingCode },
    });
    expect(paired.statusCode).toBe(200);
    expect(paired.body).not.toContain(delivery.pairingCode);
    const pairedBody = paired.json<{ csrfToken: string; principal: { userId: string } }>();
    expect(pairedBody.csrfToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const workspaceGrant = await feature.localAdministration.grantWorkspace(
      pairedBody.principal.userId,
      'project_synthetic-1'
    );
    const setCookies = cookies(paired);
    expect(setCookies).toHaveLength(2);
    expect(setCookies.every((value) => value.includes('HttpOnly'))).toBe(true);
    expect(setCookies.every((value) => value.includes('SameSite=Strict'))).toBe(true);
    const session = cookieValue(setCookies, '__Host-agent-teams-session');
    const device = cookieValue(setCookies, '__Host-agent-teams-device');
    expect(session).not.toBe('attacker-fixed-session');

    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/personal/pair',
      headers: {
        origin: 'http://agent-teams.test',
        'sec-fetch-site': 'same-origin',
      },
      payload: { pairingCode: delivery.pairingCode },
    });
    expect(replay.statusCode).toBe(401);

    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/api/config/pin-session',
      headers: { cookie: `__Host-agent-teams-session=${session}` },
      payload: { projectId: workspaceGrant.workspaceId, sessionId: 'session-synthetic' },
    });
    expect(missingCsrf.statusCode).toBe(403);

    const command = await app.inject({
      method: 'POST',
      url: '/api/config/pin-session',
      headers: {
        cookie: `__Host-agent-teams-session=${session}`,
        origin: 'http://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': pairedBody.csrfToken,
      },
      payload: { projectId: workspaceGrant.workspaceId, sessionId: 'session-synthetic' },
    });
    expect(command.statusCode).toBe(200);

    const loggedOut = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie: `__Host-agent-teams-session=${session}; __Host-agent-teams-device=${device}`,
        origin: 'http://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': pairedBody.csrfToken,
      },
      payload: { global: false },
    });
    expect(loggedOut.statusCode).toBe(200);
    expect(cookies(loggedOut)).toHaveLength(1);
    expect(cookies(loggedOut)[0]).toContain('__Host-agent-teams-session=');
    expect(cookies(loggedOut)[0]).not.toContain('__Host-agent-teams-device=');

    const restarted = await featureHarness(directory, storage);
    const restartedApp = Fastify();
    apps.push(restartedApp);
    restarted.feature.http.register(restartedApp);
    const renewed = await restartedApp.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { cookie: `__Host-agent-teams-device=${device}` },
    });
    expect(renewed.statusCode).toBe(200);
    expect(
      renewed.json(),
      storage instanceof SyntheticHostedAuthStorage
        ? JSON.stringify(storage.audits.slice(-3))
        : 'native-sqlite'
    ).toMatchObject({
      authenticated: true,
      mode: 'personal',
      principal: { role: 'owner', authenticationMethod: 'personal' },
    });
    expect(cookieValue(cookies(renewed), '__Host-agent-teams-session')).not.toBe(session);
    const renewedSession = cookieValue(cookies(renewed), '__Host-agent-teams-session');
    const renewedDevice = cookieValue(cookies(renewed), '__Host-agent-teams-device');
    expect(renewedDevice).not.toBe(device);

    await expect(restarted.feature.localAdministration.resetPersonal(1)).resolves.toEqual({
      resetGeneration: 1,
    });
    const resetDelivery = JSON.parse(readFileSync(pairingPath, 'utf8')) as {
      pairingCode: string;
      expiresAt: number;
    };
    const resetKeyring = JSON.parse(
      readFileSync(join(directory, 'secrets', 'personal-keyring.json'), 'utf8')
    ) as { keyringId: string };
    expect(resetDelivery.pairingCode).not.toBe(delivery.pairingCode);
    expect(resetKeyring.keyringId).not.toBe(originalKeyring.keyringId);

    const revokedAfterReset = await restartedApp.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: {
        cookie: `__Host-agent-teams-session=${renewedSession}; __Host-agent-teams-device=${renewedDevice}`,
      },
    });
    expect(revokedAfterReset.json()).toMatchObject({ authenticated: false, mode: 'personal' });

    const repaired = await restartedApp.inject({
      method: 'POST',
      url: '/api/auth/personal/pair',
      headers: {
        origin: 'http://agent-teams.test',
        'sec-fetch-site': 'same-origin',
      },
      payload: { pairingCode: resetDelivery.pairingCode },
    });
    expect(repaired.statusCode).toBe(200);
    const repairedCookies = cookies(repaired);
    const repairedSession = cookieValue(repairedCookies, '__Host-agent-teams-session');
    const repairedDevice = cookieValue(repairedCookies, '__Host-agent-teams-device');
    const repairedCsrf = repaired.json<{ csrfToken: string }>().csrfToken;

    const forgotten = await restartedApp.inject({
      method: 'POST',
      url: '/api/auth/personal/forget-device',
      headers: {
        cookie: `__Host-agent-teams-session=${repairedSession}; __Host-agent-teams-device=${repairedDevice}`,
        origin: 'http://agent-teams.test',
        'sec-fetch-site': 'same-origin',
        'x-agent-teams-csrf': repairedCsrf,
      },
      payload: {},
    });
    expect(forgotten.statusCode).toBe(200);
    expect(cookies(forgotten)).toHaveLength(2);
    expect(cookies(forgotten).every((value) => value.includes('Max-Age=0'))).toBe(true);

    const forgottenDevice = await restartedApp.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { cookie: `__Host-agent-teams-device=${repairedDevice}` },
    });
    expect(forgottenDevice.json()).toMatchObject({ authenticated: false, mode: 'personal' });
  });
});
