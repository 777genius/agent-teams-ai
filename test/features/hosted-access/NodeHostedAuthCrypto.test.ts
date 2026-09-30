import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';

import {
  parseAuditEventId,
  parseAuthKeyringId,
  parseDeviceFamilyId,
  parseDeviceGrantId,
  parseHostedSessionId,
  parseHostedWorkspaceId,
  parseOidcLoginAttemptId,
  parseOperatorId,
  parseOperatorSessionId,
  parsePairingChallengeId,
  parseUserId,
} from '@features/hosted-access';
import {
  NodeHostedIdentityCrypto,
  prepareHostedAuthSecretPaths,
  readProtectedHostedAuthSecret,
  readProtectedOwnedHostedAuthFile,
} from '@features/hosted-access/main/infrastructure/NodeHostedIdentityCrypto';
import { NodePersonalAuthorityCrypto } from '@features/hosted-access/main/infrastructure/NodePersonalAuthorityAdapters';
import { describe, expect, it } from 'vitest';

import type { HostedAuthHostPlatform, HostedAuthPathStat } from '@features/hosted-access';

const identifierPlatform = {
  randomBytes,
  base64UrlEncode: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url'),
} as unknown as HostedAuthHostPlatform;

function pathStat(input: {
  readonly kind: 'directory' | 'file' | 'other';
  readonly uid: number;
  readonly mode: number;
  readonly dev?: number;
  readonly ino?: number;
  readonly symbolicLink?: boolean;
  readonly socket?: boolean;
}): HostedAuthPathStat {
  return {
    dev: input.dev ?? 1,
    ino: input.ino ?? 1,
    uid: input.uid,
    mode: input.mode,
    isDirectory: () => input.kind === 'directory',
    isFile: () => input.kind === 'file',
    isSocket: () => input.socket === true,
    isSymbolicLink: () => input.symbolicLink === true,
  };
}

function secretPlatform(input: {
  readonly filePath: string;
  readonly file: HostedAuthPathStat;
  readonly readValue?: string;
  readonly openedFile?: HostedAuthPathStat;
  readonly replacementFile?: HostedAuthPathStat;
  readonly unsafeParent?: string;
  readonly replacedParent?: string;
  readonly openError?: Error;
  readonly privateParent?: boolean;
}): HostedAuthHostPlatform {
  const parentStats = new Map<string, HostedAuthPathStat>();
  let parent = dirname(input.filePath);
  const directParent = parent;
  let ino = 10;
  for (;;) {
    const privateParent = input.privateParent === true && parent === directParent;
    parentStats.set(
      parent,
      pathStat({
        kind: 'directory',
        uid: privateParent ? 1000 : 0,
        mode: privateParent ? 0o40700 : 0o40755,
        ino,
      })
    );
    ino += 1;
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  let fileReads = 0;
  let closed = false;
  return {
    uid: 1000,
    join,
    dirname,
    isAbsolute,
    byteLength: (value: string) => Buffer.byteLength(value),
    lstat: (path: string) => {
      if (path === input.filePath) {
        fileReads += 1;
        return Promise.resolve(
          fileReads > 1 && input.replacementFile ? input.replacementFile : input.file
        );
      }
      const stat = parentStats.get(path);
      if (stat) {
        if (input.unsafeParent === path) {
          return Promise.resolve({ ...stat, uid: 1000, mode: 0o40777 });
        }
        return Promise.resolve(
          input.replacedParent === path && fileReads > 1
            ? { ...stat, ino: stat.ino + 10_000 }
            : stat
        );
      }
      return Promise.reject(new Error('unexpected_test_path'));
    },
    openReadOnlyNoFollow: () =>
      input.openError
        ? Promise.reject(input.openError)
        : Promise.resolve({
            stat: () => Promise.resolve(input.openedFile ?? input.file),
            readTextBounded: (maximumBytes: number) => {
              const value = input.readValue ?? 'synthetic-client-secret\n';
              if (Buffer.byteLength(value) > maximumBytes) {
                return Promise.reject(new Error('hosted_auth_secret_too_large'));
              }
              return Promise.resolve(value);
            },
            close: () => {
              closed = true;
              return Promise.resolve();
            },
          }),
    get closed() {
      return closed;
    },
  } as unknown as HostedAuthHostPlatform;
}

describe('hosted authentication production identifier generation', () => {
  it('always emits parser-compatible identity identifiers', async () => {
    const crypto = new NodeHostedIdentityCrypto(
      '/not-used-for-random-identifiers',
      identifierPlatform
    );
    const parsers = {
      'audit-event': parseAuditEventId,
      'oidc-attempt': parseOidcLoginAttemptId,
      session: parseHostedSessionId,
      user: parseUserId,
      workspace: parseHostedWorkspaceId,
    } as const;

    for (const [kind, parse] of Object.entries(parsers)) {
      for (let index = 0; index < 128; index += 1) {
        expect(parse(await crypto.randomId(kind as keyof typeof parsers))).toMatch(
          kind === 'workspace' ? /^workspace_[a-f0-9]{32}$/u : /^[a-z][a-z0-9-]*_x/
        );
      }
    }
  });

  it('always emits parser-compatible personal-authority identifiers', async () => {
    const crypto = new NodePersonalAuthorityCrypto(identifierPlatform);
    const parsers = {
      'auth-keyring': parseAuthKeyringId,
      'device-family': parseDeviceFamilyId,
      'device-grant': parseDeviceGrantId,
      operator: parseOperatorId,
      'pairing-challenge': parsePairingChallengeId,
      session: parseOperatorSessionId,
    } as const;

    for (const [kind, parse] of Object.entries(parsers)) {
      for (let index = 0; index < 128; index += 1) {
        expect(parse(await crypto.randomId(kind as keyof typeof parsers))).toMatch(
          /^[a-z][a-z0-9-]*_x/
        );
      }
    }
  });
});

describe('hosted OIDC client-secret file boundary', () => {
  it('reads a restrictive service-owned Docker secret only through its opened descriptor', async () => {
    const filePath = '/run/secrets/oidc_client_secret';
    const platform = secretPlatform({
      filePath,
      file: pathStat({ kind: 'file', uid: 1000, mode: 0o100400, ino: 40 }),
    });

    await expect(readProtectedHostedAuthSecret(filePath, platform)).resolves.toBe(
      'synthetic-client-secret'
    );
  });

  it.each([
    pathStat({ kind: 'file', uid: 1000, mode: 0o100440, ino: 40 }),
    pathStat({ kind: 'file', uid: 0, mode: 0o100400, ino: 40 }),
    pathStat({
      kind: 'file',
      uid: 1000,
      mode: 0o100400,
      ino: 40,
      symbolicLink: true,
    }),
    pathStat({ kind: 'other', uid: 1000, mode: 0o010400, ino: 40 }),
    pathStat({ kind: 'other', uid: 1000, mode: 0o020400, ino: 40 }),
  ])('rejects unsafe mode, owner, symlink, FIFO, and device inputs', async (file) => {
    const dockerPath = '/run/secrets/oidc_client_secret';
    await expect(
      readProtectedHostedAuthSecret(dockerPath, secretPlatform({ filePath: dockerPath, file }))
    ).rejects.toThrow('hosted_auth_config_invalid:OIDC_CLIENT_SECRET_FILE');
  });

  it('rejects descriptor identity mismatch, pathname replacement, and parent replacement', async () => {
    const dockerPath = '/run/secrets/oidc_client_secret';
    const safe = pathStat({ kind: 'file', uid: 1000, mode: 0o100400, ino: 40 });
    await expect(
      readProtectedHostedAuthSecret(
        dockerPath,
        secretPlatform({
          filePath: dockerPath,
          file: safe,
          unsafeParent: '/run/secrets',
        })
      )
    ).rejects.toThrow('hosted_auth_config_invalid:OIDC_CLIENT_SECRET_FILE');
    await expect(
      readProtectedHostedAuthSecret(
        dockerPath,
        secretPlatform({
          filePath: dockerPath,
          file: safe,
          openedFile: { ...safe, ino: 41 },
        })
      )
    ).rejects.toThrow('hosted_auth_config_invalid:OIDC_CLIENT_SECRET_FILE');
    await expect(
      readProtectedHostedAuthSecret(
        dockerPath,
        secretPlatform({
          filePath: dockerPath,
          file: safe,
          replacementFile: { ...safe, ino: 42 },
        })
      )
    ).rejects.toThrow('hosted_auth_config_invalid:OIDC_CLIENT_SECRET_FILE');
    await expect(
      readProtectedHostedAuthSecret(
        dockerPath,
        secretPlatform({
          filePath: dockerPath,
          file: safe,
          replacedParent: '/run/secrets',
        })
      )
    ).rejects.toThrow('hosted_auth_config_invalid:OIDC_CLIENT_SECRET_FILE');
  });

  it('rejects a path replaced by a symlink when the no-follow descriptor is opened', async () => {
    const dockerPath = '/run/secrets/oidc_client_secret';
    await expect(
      readProtectedHostedAuthSecret(
        dockerPath,
        secretPlatform({
          filePath: dockerPath,
          file: pathStat({ kind: 'file', uid: 1000, mode: 0o100400, ino: 40 }),
          openError: Object.assign(new Error('symlink refused'), { code: 'ELOOP' }),
        })
      )
    ).rejects.toThrow('hosted_auth_config_invalid:OIDC_CLIENT_SECRET_FILE');
  });

  it('rejects broad-readable non-service secrets', async () => {
    const externalPath = '/deployment/oidc-client-secret';
    await expect(
      readProtectedHostedAuthSecret(
        externalPath,
        secretPlatform({
          filePath: externalPath,
          file: pathStat({ kind: 'file', uid: 1000, mode: 0o100444 }),
        })
      )
    ).rejects.toThrow('hosted_auth_config_invalid:OIDC_CLIENT_SECRET_FILE');
  });

  it('bounds the descriptor read before decoding the secret', async () => {
    const filePath = '/run/secrets/oidc_client_secret';
    await expect(
      readProtectedHostedAuthSecret(
        filePath,
        secretPlatform({
          filePath,
          file: pathStat({ kind: 'file', uid: 1000, mode: 0o100400, ino: 40 }),
          readValue: 'x'.repeat(8_193),
        })
      )
    ).rejects.toThrow('hosted_auth_config_invalid:OIDC_CLIENT_SECRET_FILE');
  });
});

describe('hosted deployment-owned secret file boundary', () => {
  const filePath = '/deployment/private/personal-keyring.json';
  const safeFile = pathStat({ kind: 'file', uid: 1000, mode: 0o100600, ino: 40 });

  it('reads only the stable private file descriptor', async () => {
    await expect(
      readProtectedOwnedHostedAuthFile(
        filePath,
        secretPlatform({
          filePath,
          file: safeFile,
          privateParent: true,
          readValue: 'protected-auth-material',
        }),
        128,
        'protected_file_invalid'
      )
    ).resolves.toBe('protected-auth-material');
  });

  it('rejects weakened permissions, file replacement, parent replacement and oversized input', async () => {
    const candidates = [
      secretPlatform({
        filePath,
        file: pathStat({ kind: 'file', uid: 1000, mode: 0o100640, ino: 40 }),
        privateParent: true,
      }),
      secretPlatform({
        filePath,
        file: safeFile,
        openedFile: { ...safeFile, ino: 41 },
        privateParent: true,
      }),
      secretPlatform({
        filePath,
        file: safeFile,
        replacementFile: { ...safeFile, ino: 42 },
        privateParent: true,
      }),
      secretPlatform({
        filePath,
        file: safeFile,
        privateParent: true,
        replacedParent: dirname(filePath),
      }),
      secretPlatform({
        filePath,
        file: safeFile,
        privateParent: true,
        readValue: 'x'.repeat(129),
      }),
    ];
    for (const platform of candidates) {
      await expect(
        readProtectedOwnedHostedAuthFile(filePath, platform, 128, 'protected_file_invalid')
      ).rejects.toThrow('protected_file_invalid');
    }
  });
});

describe('hosted identity-key path boundary', () => {
  function preparationPlatform(
    identityDirectory: HostedAuthPathStat,
    chmodPaths: string[] = []
  ): HostedAuthHostPlatform {
    const dataDirectory = '/deployment/data';
    const secretsDirectory = join(dataDirectory, 'hosted-auth-secrets');
    return {
      uid: 1000,
      join,
      dirname,
      isAbsolute,
      mkdir: () => Promise.resolve(),
      chmod: (path: string) => {
        chmodPaths.push(path);
        return Promise.resolve();
      },
      lstat: (path: string) => {
        if (path === secretsDirectory) {
          return Promise.resolve(pathStat({ kind: 'directory', uid: 1000, mode: 0o40700 }));
        }
        if (path === '/deployment/keys') return Promise.resolve(identityDirectory);
        return Promise.reject(new Error('unexpected_test_path'));
      },
    } as unknown as HostedAuthHostPlatform;
  }

  it('locks an explicitly configured identity-key directory before returning it', async () => {
    const chmodPaths: string[] = [];
    const result = await prepareHostedAuthSecretPaths(
      {
        dataDirectory: '/deployment/data',
        identityKeyPath: '/deployment/keys/identity.key',
      },
      preparationPlatform(pathStat({ kind: 'directory', uid: 1000, mode: 0o40755 }), chmodPaths)
    );

    expect(result.identityKeyPath).toBe('/deployment/keys/identity.key');
    expect(chmodPaths).toEqual(['/deployment/data/hosted-auth-secrets', '/deployment/keys']);
  });

  it('rejects relative, linked, or foreign-owned identity-key directories', async () => {
    await expect(
      prepareHostedAuthSecretPaths(
        { dataDirectory: '/deployment/data', identityKeyPath: 'relative/identity.key' },
        preparationPlatform(pathStat({ kind: 'directory', uid: 1000, mode: 0o40700 }))
      )
    ).rejects.toThrow('hosted_auth_identity_key_path_invalid');
    await expect(
      prepareHostedAuthSecretPaths(
        {
          dataDirectory: '/deployment/data',
          identityKeyPath: '/deployment/keys/identity.key',
        },
        preparationPlatform(
          pathStat({
            kind: 'directory',
            uid: 1000,
            mode: 0o40700,
            symbolicLink: true,
          })
        )
      )
    ).rejects.toThrow('hosted_auth_identity_key_directory_invalid');
    await expect(
      prepareHostedAuthSecretPaths(
        {
          dataDirectory: '/deployment/data',
          identityKeyPath: '/deployment/keys/identity.key',
        },
        preparationPlatform(pathStat({ kind: 'directory', uid: 0, mode: 0o40700 }))
      )
    ).rejects.toThrow('hosted_auth_identity_key_directory_invalid');
  });
});
