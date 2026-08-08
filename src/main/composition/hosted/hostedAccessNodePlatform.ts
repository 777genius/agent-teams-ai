import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';

import type { CreateHostedAccessFeatureDependencies } from '@features/hosted-access/main';
import type { JsonWebKey } from 'node:crypto';
import type { Server, Socket } from 'node:net';

type HostedAuthHostPlatform = CreateHostedAccessFeatureDependencies['hostPlatform'];
type HostedAuthLocalControlTransportFactory =
  CreateHostedAccessFeatureDependencies['localControlTransportFactory'];

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createHostedAccessNodePlatform(): HostedAuthHostPlatform {
  const platform: HostedAuthHostPlatform = {
    uid: process.getuid?.(),
    pid: process.pid,
    join: (...segments: readonly string[]) => join(...segments),
    dirname,
    isAbsolute,
    byteLength: (value: string) => Buffer.byteLength(value),
    mkdir: async (path: string, mode: number) => {
      await mkdir(path, { recursive: true, mode });
    },
    lstat,
    openReadOnlyNoFollow: async (path: string) => {
      const portableConstants = fsConstants as Readonly<Record<string, number | undefined>>;
      const noFollow = portableConstants.O_NOFOLLOW ?? 0;
      const closeOnExec = portableConstants.O_CLOEXEC ?? 0;
      const handle = await open(path, fsConstants.O_RDONLY | noFollow | closeOnExec);
      return Object.freeze({
        stat: () => handle.stat(),
        readTextBounded: async (maximumBytes: number) => {
          if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
            throw new TypeError('hosted_auth_read_bound_invalid');
          }
          const bytes = Buffer.alloc(maximumBytes + 1);
          let offset = 0;
          for (;;) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
            if (offset > maximumBytes) throw new Error('hosted_auth_secret_too_large');
          }
          return bytes.subarray(0, offset).toString('utf8');
        },
        close: () => handle.close(),
      });
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
      await syncDirectory(dirname(path));
    },
    rename: async (source, destination) => {
      await rename(source, destination);
      const sourceDirectory = dirname(source);
      const destinationDirectory = dirname(destination);
      await syncDirectory(destinationDirectory);
      if (sourceDirectory !== destinationDirectory) await syncDirectory(sourceDirectory);
    },
    remove: async (path, options) => {
      await rm(path, options);
      await syncDirectory(dirname(path));
    },
    randomBytes: (size: number) => randomBytes(size),
    base64UrlEncode: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url'),
    base64UrlDecode: (value: string) => Buffer.from(value, 'base64url'),
    hmacSha256: (key, parts, encoding) => {
      const hmac = createHmac('sha256', key);
      for (const part of parts) hmac.update(part);
      return hmac.digest(encoding);
    },
    hkdfSha256: (input, salt, info, length) =>
      new Uint8Array(hkdfSync('sha256', input, salt, Buffer.from(info, 'utf8'), length)),
    sha256Base64Url: (value: string) => createHash('sha256').update(value).digest('base64url'),
    verifyOidcSignature: (input) => {
      const digest = input.algorithm === 'EdDSA' ? null : `sha${input.algorithm.slice(-3)}`;
      const publicKey = createPublicKey({ key: input.jwk as JsonWebKey, format: 'jwk' });
      const options = input.algorithm.startsWith('PS')
        ? {
            key: publicKey,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: Number(input.algorithm.slice(-3)) / 8,
          }
        : input.algorithm.startsWith('ES')
          ? { key: publicKey, dsaEncoding: 'ieee-p1363' as const }
          : publicKey;
      return verifySignature(digest, Buffer.from(input.signingInput), options, input.signature);
    },
    encryptAes256Gcm: (input) => {
      const cipher = createCipheriv('aes-256-gcm', input.key, input.nonce);
      cipher.setAAD(Buffer.from(input.aad, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]);
      return Object.freeze({ ciphertext, tag: cipher.getAuthTag() });
    },
    decryptAes256Gcm: (input) => {
      const decipher = createDecipheriv('aes-256-gcm', input.key, input.nonce);
      decipher.setAAD(Buffer.from(input.aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(input.tag));
      return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]).toString('utf8');
    },
    secureEqual: (left: string, right: string) => {
      const leftBuffer = Buffer.from(left);
      const rightBuffer = Buffer.from(right);
      return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
    },
  };
  return Object.freeze(platform);
}

export function createHostedAccessNodeLocalControlTransportFactory(
  platform: HostedAuthHostPlatform
): HostedAuthLocalControlTransportFactory {
  const factory: HostedAuthLocalControlTransportFactory = {
    create: (options) => {
      let server: Server | null = null;
      const removeOwnedSocket = async (checkActive: boolean): Promise<void> => {
        try {
          const stat = await lstat(options.socketPath);
          if (!stat.isSocket() || (platform.uid !== undefined && stat.uid !== platform.uid)) {
            throw new Error('hosted_local_control_socket_path_occupied');
          }
          if (checkActive && (await isSocketActive(options.socketPath))) {
            throw new Error('hosted_local_control_socket_path_occupied');
          }
          await rm(options.socketPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
      return Object.freeze({
        start: async (handler: (requestBody: string) => Promise<string>) => {
          if (server !== null) return;
          const socketDirectory = dirname(options.socketPath);
          await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
          const directoryStat = await lstat(socketDirectory);
          if (
            !directoryStat.isDirectory() ||
            directoryStat.isSymbolicLink() ||
            (platform.uid !== undefined && directoryStat.uid !== platform.uid)
          ) {
            throw new Error('hosted_local_control_socket_directory_invalid');
          }
          await chmod(socketDirectory, 0o700);
          await removeOwnedSocket(true);
          const nextServer = createServer((socket) => handleSocket(socket, options, handler));
          nextServer.maxConnections = 16;
          await listen(nextServer, options.socketPath);
          try {
            await chmod(options.socketPath, 0o600);
            server = nextServer;
          } catch (error) {
            await close(nextServer);
            await removeOwnedSocket(false);
            throw error;
          }
        },
        close: async () => {
          const activeServer = server;
          server = null;
          if (activeServer !== null) await close(activeServer);
          await removeOwnedSocket(false);
        },
      });
    },
  };
  return Object.freeze(factory);
}

function isSocketActive(socketPath: string): Promise<boolean> {
  return new Promise((resolveActive) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (active: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveActive(active);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function handleSocket(
  socket: Socket,
  options: Readonly<{ requestTimeoutMs: number; maximumRequestBytes: number }>,
  handler: (requestBody: string) => Promise<string>
): void {
  let body = '';
  let receivedBytes = 0;
  let handled = false;
  socket.setEncoding('utf8');
  socket.setTimeout(options.requestTimeoutMs, () => socket.destroy());
  socket.on('data', (chunk: string) => {
    if (handled) return;
    receivedBytes += Buffer.byteLength(chunk);
    if (receivedBytes > options.maximumRequestBytes) {
      handled = true;
      socket.end('{"ok":false,"code":"request_too_large"}\n');
      return;
    }
    body += chunk;
    const newline = body.indexOf('\n');
    if (newline < 0) return;
    handled = true;
    if (body.slice(newline + 1).trim().length !== 0) {
      socket.end('{"ok":false,"code":"request_invalid"}\n');
      return;
    }
    void handler(body.slice(0, newline))
      .then((result) => socket.end(result))
      .catch(() => socket.end('{"ok":false,"code":"internal_error"}\n'));
  });
  socket.on('error', () => undefined);
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolveListening, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolveListening();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}
