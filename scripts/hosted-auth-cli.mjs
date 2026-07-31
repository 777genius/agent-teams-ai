#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = `Usage:
  node scripts/hosted-auth-cli.mjs preflight
  node scripts/hosted-auth-cli.mjs pairing-code
  node scripts/hosted-auth-cli.mjs users list
  node scripts/hosted-auth-cli.mjs users enable <user-id>
  node scripts/hosted-auth-cli.mjs users disable <user-id>
  node scripts/hosted-auth-cli.mjs roles set <user-id> <owner|admin|member|viewer>
  node scripts/hosted-auth-cli.mjs roles clear <user-id>
  node scripts/hosted-auth-cli.mjs workspaces list
  node scripts/hosted-auth-cli.mjs workspaces register <workspace-id> [display-name]
  node scripts/hosted-auth-cli.mjs workspaces disable <workspace-id>
  node scripts/hosted-auth-cli.mjs workspaces grant <user-id> <workspace-id>
  node scripts/hosted-auth-cli.mjs workspaces revoke <user-id> <workspace-id>
  node scripts/hosted-auth-cli.mjs personal-reset <positive-generation>
  node scripts/hosted-auth-cli.mjs auth-mode reset <personal|oidc> <positive-generation>
`;

function fail(message, exitCode = 1) {
  process.stderr.write(`${message}\n`);
  process.exitCode = exitCode;
}

const MAXIMUM_PAIRING_DELIVERY_BYTES = 4 * 1024;
const PAIRING_CHALLENGE_PATTERN = /^[a-z][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{32,512}$/u;
const REPOSITORY_BUILD_CONTEXT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function isEqualToOrWithin(parentPath, candidatePath) {
  const pathFromParent = relative(parentPath, candidatePath);
  return (
    pathFromParent === '' ||
    (pathFromParent !== '..' &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

async function preflightHostedSecretsDirectory() {
  const configuredPath = process.env.HOSTED_SECRETS_DIR;
  if (configuredPath === undefined || !isAbsolute(configuredPath)) {
    throw new Error('unavailable');
  }
  const absoluteConfiguredPath = resolve(configuredPath);
  const [repositoryBuildContext, resolvedSecretsDirectory] = await Promise.all([
    realpath(REPOSITORY_BUILD_CONTEXT),
    realpath(absoluteConfiguredPath),
  ]);
  const secretsDirectory = await lstat(resolvedSecretsDirectory);
  if (
    !secretsDirectory.isDirectory() ||
    isEqualToOrWithin(repositoryBuildContext, absoluteConfiguredPath) ||
    isEqualToOrWithin(repositoryBuildContext, resolvedSecretsDirectory)
  ) {
    throw new Error('unavailable');
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPrivateOwned(stat, kind) {
  const uid = process.getuid?.();
  const expectedKind = kind === 'directory' ? stat.isDirectory() : stat.isFile();
  if (
    !expectedKind ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (uid !== undefined && stat.uid !== uid)
  ) {
    throw new Error('unavailable');
  }
}

async function readPairingDelivery(path) {
  if (!isAbsolute(path) || normalize(path) !== path) throw new Error('unavailable');
  const parentPath = dirname(path);
  const parentBefore = await lstat(parentPath);
  assertPrivateOwned(parentBefore, 'directory');
  const before = await lstat(path);
  assertPrivateOwned(before, 'file');
  const portableConstants = fsConstants;
  const noFollow =
    typeof portableConstants.O_NOFOLLOW === 'number' ? portableConstants.O_NOFOLLOW : 0;
  const closeOnExec =
    typeof portableConstants.O_CLOEXEC === 'number' ? portableConstants.O_CLOEXEC : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow | closeOnExec);
  try {
    const opened = await handle.stat();
    assertPrivateOwned(opened, 'file');
    if (!sameFileIdentity(before, opened)) throw new Error('unavailable');
    const after = await lstat(path);
    assertPrivateOwned(after, 'file');
    if (!sameFileIdentity(opened, after)) throw new Error('unavailable');
    const parentAfter = await lstat(parentPath);
    assertPrivateOwned(parentAfter, 'directory');
    if (!sameFileIdentity(parentBefore, parentAfter)) throw new Error('unavailable');
    const bytes = Buffer.alloc(MAXIMUM_PAIRING_DELIVERY_BYTES + 1);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > MAXIMUM_PAIRING_DELIVERY_BYTES) throw new Error('unavailable');
    }
    const value = JSON.parse(bytes.subarray(0, offset).toString('utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Reflect.ownKeys(value).length !== 3 ||
      Reflect.ownKeys(value).some(
        (key) =>
          typeof key !== 'string' || !['challengeId', 'pairingCode', 'expiresAt'].includes(key)
      ) ||
      typeof value.challengeId !== 'string' ||
      !PAIRING_CHALLENGE_PATTERN.test(value.challengeId) ||
      typeof value.pairingCode !== 'string' ||
      !PAIRING_CODE_PATTERN.test(value.pairingCode) ||
      !Number.isSafeInteger(value.expiresAt)
    ) {
      throw new Error('unavailable');
    }
    return value;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function pairingCode() {
  const path = process.env.PAIRING_CODE_FILE ?? '/run/agent-teams/pairing.json';
  try {
    const value = await readPairingDelivery(path);
    if (Date.now() >= value.expiresAt) {
      throw new Error('unavailable');
    }
    process.stdout.write(`${value.pairingCode}\n`);
  } catch {
    fail('Pairing challenge is unavailable or expired.');
  }
}

function localControl(command, argumentsValue = {}) {
  const socketPath = process.env.AUTH_CONTROL_SOCKET ?? '/run/agent-teams/control.sock';
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(5_000, () => finish(new Error('local_control_timeout')));
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ version: 1, command, arguments: argumentsValue })}\n`,
        'utf8'
      );
    });
    socket.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) {
        finish(new Error('local_control_response_invalid'));
        return;
      }
      const newline = body.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(body.slice(0, newline));
        if (response?.ok === true) finish(null, response.value);
        else if (response?.ok === false && typeof response.code === 'string') {
          finish(new Error(response.code));
        } else {
          finish(new Error('local_control_response_invalid'));
        }
      } catch {
        finish(new Error('local_control_response_invalid'));
      }
    });
    socket.on('error', () => finish(new Error('local_control_unavailable')));
    socket.on('end', () => {
      if (!settled) finish(new Error('local_control_response_invalid'));
    });
  });
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const [scope, action, first, ...remaining] = process.argv.slice(2);
  if (scope === 'preflight' && action === undefined) {
    try {
      await preflightHostedSecretsDirectory();
      printJson({ ready: true });
    } catch {
      fail(
        'Hosted authentication preflight failed: HOSTED_SECRETS_DIR must resolve to an existing absolute directory outside the repository Docker build context.'
      );
    }
    return;
  }
  if (scope === 'pairing-code' && action === undefined) {
    await pairingCode();
    return;
  }

  let command;
  let argumentsValue = {};
  if (scope === 'users' && action === 'list' && first === undefined) {
    command = 'users.list';
  } else if (
    scope === 'users' &&
    (action === 'enable' || action === 'disable') &&
    first !== undefined &&
    remaining.length === 0
  ) {
    command = `users.${action}`;
    argumentsValue = { userId: first };
  } else if (
    scope === 'roles' &&
    action === 'set' &&
    first !== undefined &&
    remaining.length === 1
  ) {
    command = 'roles.set';
    argumentsValue = { userId: first, role: remaining[0] };
  } else if (
    scope === 'roles' &&
    action === 'clear' &&
    first !== undefined &&
    remaining.length === 0
  ) {
    command = 'roles.clear';
    argumentsValue = { userId: first };
  } else if (scope === 'workspaces' && action === 'list' && first === undefined) {
    command = 'workspaces.list';
  } else if (
    scope === 'workspaces' &&
    action === 'register' &&
    first !== undefined &&
    remaining.length <= 1
  ) {
    command = 'workspaces.register';
    argumentsValue = { workspaceId: first, displayName: remaining[0] ?? first };
  } else if (
    scope === 'workspaces' &&
    action === 'disable' &&
    first !== undefined &&
    remaining.length === 0
  ) {
    command = 'workspaces.disable';
    argumentsValue = { workspaceId: first };
  } else if (
    scope === 'workspaces' &&
    (action === 'grant' || action === 'revoke') &&
    first !== undefined &&
    remaining.length === 1
  ) {
    command = `workspaces.${action}`;
    argumentsValue = { userId: first, workspaceId: remaining[0] };
  } else if (scope === 'personal-reset' && action !== undefined && first === undefined) {
    const resetGeneration = Number(action);
    if (!Number.isSafeInteger(resetGeneration) || resetGeneration <= 0) {
      fail(usage.trimEnd(), 2);
      return;
    }
    command = 'personal.reset';
    argumentsValue = { resetGeneration };
  } else if (
    scope === 'auth-mode' &&
    action === 'reset' &&
    (first === 'personal' || first === 'oidc') &&
    remaining.length === 1
  ) {
    const resetGeneration = Number(remaining[0]);
    if (!Number.isSafeInteger(resetGeneration) || resetGeneration <= 0) {
      fail(usage.trimEnd(), 2);
      return;
    }
    command = 'auth-mode.reset';
    argumentsValue = { targetMode: first, resetGeneration };
  } else {
    fail(usage.trimEnd(), 2);
    return;
  }

  try {
    printJson(await localControl(command, argumentsValue));
  } catch (error) {
    const code = error instanceof Error ? error.message : 'local_control_failure';
    fail(`Hosted authentication control failed: ${code}`);
  }
}

await main();
