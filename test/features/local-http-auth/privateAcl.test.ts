// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { apiProfileScope, publishApiAuthority } from '@features/local-http-auth/main';
import {
  assertPrivateWindowsAcl,
  runWindowsMcpAclScript,
  validateWindowsAncestorAcl,
} from '@features/local-http-auth/main/infrastructure/privateFileAcl';
import {
  readPrivateJson,
  replacePrivateJson,
  validatePrivatePath,
} from '@features/local-http-auth/main/infrastructure/privateFiles';
import { afterEach, beforeEach, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const controller = require(
  process.env.PRIVATE_HTTP_QUALIFY_COMPILED === '1'
    ? '../../../agent-teams-controller/dist/internal/controlApiAuth.js'
    : '../../../agent-teams-controller/src/internal/controlApiAuth.cts'
) as {
  resolveControlAuthorities(
    context: { claudeDir: string },
    flags: object,
    fixedReference: string
  ): Array<{ read(): { token: string } }>;
};
let root: string;
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(
      path.join(process.platform === 'win32' ? os.homedir() : os.tmpdir(), 'TEST-private-http-acl-')
    )
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const key = 'a'.repeat(64);
async function publication(profile = root) {
  const authority = {
    schemaVersion: 1 as const,
    service: 'api' as const,
    profileScope: apiProfileScope(profile),
    instanceId: randomUUID(),
    generation: randomUUID(),
    baseUrl: 'http://127.0.0.1:3456',
    token: key,
  };
  const reference = await publishApiAuthority(profile, authority);
  return {
    reference,
    descriptor: JSON.parse(await readFile(reference, 'utf8')).descriptorPath as string,
  };
}
const readController = (reference: string, profile = root) =>
  controller.resolveControlAuthorities({ claudeDir: profile }, {}, reference)[0].read();

it('keeps the standalone controller adapter byte-equivalent to the canonical ACL policy', async () => {
  const { renderControllerAcl } =
    await import('../../../agent-teams-controller/scripts/privateAclMirror.mts');
  const canonical = await readFile(
    path.resolve('src/features/local-http-auth/main/infrastructure/privateFileAcl.ts'),
    'utf8'
  );
  expect(
    await readFile(
      path.resolve('agent-teams-controller/src/internal/windowsPrivateAcl.cts'),
      'utf8'
    )
  ).toBe(renderControllerAcl(canonical));
});

it('loads the controller source inside an MCP-style ESM bundle', async () => {
  const viteRequire = createRequire(require.resolve('vite/package.json'));
  const esbuild = (await import(pathToFileURL(viteRequire.resolve('esbuild')).href)) as {
    build(options: object): Promise<unknown>;
  };
  const output = path.join(root, 'controller.mjs');
  await esbuild.build({
    entryPoints: [path.resolve('agent-teams-controller/src/internal/desktopControlBinding.js')],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    outfile: output,
    banner: {
      js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);",
    },
  });
  execFileSync(process.execPath, [output], { timeout: 10_000, stdio: 'pipe' });
});

it('publishes and replaces a real private authority which the controller can read', async () => {
  const { reference, descriptor } = await publication();
  expect(readController(reference).token).toBe(key);
  expect(((await readPrivateJson(descriptor)) as { token: string }).token).toBe(key);
  await replacePrivateJson(descriptor, { sentinel: true }, validatePrivatePath);
  expect(await readPrivateJson(descriptor)).toEqual({ sentinel: true });
  if (process.platform === 'win32') {
    assertPrivateWindowsAcl(path.dirname(reference));
    assertPrivateWindowsAcl(descriptor);
  } else {
    expect((await lstat(descriptor)).mode & 0o777).toBe(0o600);
  }
});

it('permits system-root readers and directory creation but rejects foreign ancestor mutation rights', () => {
  const userSid = 'S-1-5-21-1-2-3-1001';
  const base = {
    userSid,
    ownerSid: 'S-1-5-32-544',
    rules: [
      { sid: 'S-1-5-18', type: 'Allow', rights: 2032127, inheritOnly: false },
      { sid: 'S-1-1-0', type: 'Allow', rights: 131209, inheritOnly: false },
      { sid: 'S-1-5-11', type: 'Allow', rights: 4, inheritOnly: false },
    ],
  };
  expect(() => validateWindowsAncestorAcl(base)).not.toThrow();
  for (const rights of [2, 16, 64, 256, 65536, 262144, 524288, 0x40000000, 0x10000000]) {
    expect(() =>
      validateWindowsAncestorAcl({
        ...base,
        rules: [...base.rules, { sid: 'S-1-1-0', type: 'Allow', rights, inheritOnly: false }],
      })
    ).toThrow();
  }
  expect(() =>
    validateWindowsAncestorAcl({
      ...base,
      rules: [...base.rules, { sid: 'S-1-1-0', type: 'Allow', rights: 64, inheritOnly: true }],
    })
  ).not.toThrow();
});

it.skipIf(process.platform !== 'darwin')(
  'refuses a real named reader on a private file for both reader paths and before replacement',
  async () => {
    const { reference, descriptor } = await publication();
    const before = await readFile(descriptor, 'utf8');
    execFileSync('/bin/chmod', ['+a', 'user:nobody allow read', descriptor]);
    try {
      await expect(readPrivateJson(descriptor)).rejects.toThrow('not private');
      expect(() => readController(reference)).toThrow('not private');
      await expect(
        replacePrivateJson(descriptor, { token: 'new-secret' }, validatePrivatePath)
      ).rejects.toThrow('not private');
      expect(await readFile(descriptor, 'utf8')).toBe(before);
      expect((await lstat(descriptor)).mode & 0o777).toBe(0o600);
    } finally {
      execFileSync('/bin/chmod', ['-a', 'user:nobody allow read', descriptor]);
    }
  }
);

it.skipIf(process.platform !== 'darwin')(
  'refuses named ancestor mutation for the controller and before creating credential files',
  async () => {
    const profile = path.join(root, 'profile');
    await mkdir(profile);
    const { reference } = await publication(profile);
    const next = path.join(profile, 'next-profile');
    await mkdir(next);
    execFileSync('/bin/chmod', ['+a', 'user:nobody allow delete_child,add_file', root]);
    try {
      expect(() => readController(reference, profile)).toThrow('not private');
      await expect(publication(next)).rejects.toThrow('not private');
      expect(await readdir(next)).toEqual([]);
    } finally {
      execFileSync('/bin/chmod', ['-a', 'user:nobody allow delete_child,add_file', root]);
    }
  }
);

it.skipIf(process.platform !== 'darwin')(
  'refuses an inherited named reader before any credential bytes are written',
  async () => {
    execFileSync('/bin/chmod', [
      '+a',
      'user:nobody allow read,file_inherit,directory_inherit',
      root,
    ]);
    try {
      await expect(publication()).rejects.toThrow('not private');
      const directory = path.join(root, 'local-http-auth');
      expect(await readdir(directory)).toEqual([]);
    } finally {
      execFileSync('/bin/chmod', [
        '-a',
        'user:nobody allow read,file_inherit,directory_inherit',
        root,
      ]);
    }
  }
);

it.skipIf(process.platform !== 'win32')(
  'refuses a real broad Windows file ACL for both readers and before replacement',
  async () => {
    const { reference, descriptor } = await publication();
    const before = await readFile(descriptor, 'utf8');
    runWindowsMcpAclScript(
      `$p='${descriptor.replace(/'/g, "''")}'; $a=[System.IO.File]::GetAccessControl($p); $r=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); [System.IO.File]::SetAccessControl($p,$a)`
    );
    await expect(readPrivateJson(descriptor)).rejects.toThrow('not private');
    expect(() => readController(reference)).toThrow('not private');
    await expect(
      replacePrivateJson(descriptor, { token: 'new-secret' }, validatePrivatePath)
    ).rejects.toThrow('not private');
    expect(await readFile(descriptor, 'utf8')).toBe(before);
  }
);

it.skipIf(process.platform !== 'win32')(
  'refuses actual Windows ancestor delete rights before creating credential files',
  async () => {
    const profile = path.join(root, 'profile');
    await mkdir(profile);
    const { reference } = await publication(profile);
    const next = path.join(profile, 'next-profile');
    await mkdir(next);
    runWindowsMcpAclScript(
      `$p='${root.replace(/'/g, "''")}'; $a=[System.IO.Directory]::GetAccessControl($p); $r=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,[System.Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); [System.IO.Directory]::SetAccessControl($p,$a)`
    );
    expect(() => readController(reference, profile)).toThrow();
    await expect(publication(next)).rejects.toThrow();
    expect(await readdir(next)).toEqual([]);
  }
);

it.skipIf(process.platform !== 'win32')(
  'uses WinPS5 OS modules without inheriting MCP credentials',
  () => {
    const field = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_HEADERS_JSON',
      oldKey = process.env[field],
      oldModules = process.env.PSModulePath;
    try {
      process.env[field] = 'TEST-synthetic-must-not-reach-ACL-process';
      process.env.PSModulePath = 'C:\\TEST-PS7-modules';
      const actual = JSON.parse(
        runWindowsMcpAclScript(
          `@{major=$PSVersionTable.PSVersion.Major;modulePath=$env:PSModulePath;credential=[bool][System.Environment]::GetEnvironmentVariable('${field}')} | ConvertTo-Json -Compress`
        )
      );
      expect(actual.major).toBe(5);
      expect(actual.credential).toBe(false);
      expect(actual.modulePath.toLowerCase()).toBe(
        path.win32
          .join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'Modules'
          )
          .toLowerCase()
      );
    } finally {
      if (oldKey === undefined) delete process.env[field];
      else process.env[field] = oldKey;
      if (oldModules === undefined) delete process.env.PSModulePath;
      else process.env.PSModulePath = oldModules;
    }
  }
);

it.skipIf(
  process.platform !== 'linux' ||
    (process.getuid?.() !== 0 && process.env.PRIVATE_ACL_QUALIFY_FOREIGN_OWNER !== '1')
)('refuses a real foreign-owned existing file without altering its bytes', async () => {
  const { descriptor } = await publication(),
    before = await readFile(descriptor, 'utf8');
  const uid = process.getuid!(),
    gid = process.getgid!();
  const chown = (owner: string) =>
    execFileSync(
      uid === 0 ? 'chown' : 'sudo',
      uid === 0 ? [owner, descriptor] : ['-n', 'chown', owner, descriptor]
    );
  chown('65534:65534');
  try {
    await expect(readPrivateJson(descriptor)).rejects.toThrow();
    await expect(
      replacePrivateJson(descriptor, { token: 'new-secret' }, validatePrivatePath)
    ).rejects.toThrow();
    expect((await lstat(descriptor)).uid).toBe(65534);
  } finally {
    chown(`${uid}:${gid}`);
  }
  expect(await readFile(descriptor, 'utf8')).toBe(before);
});

it.runIf(process.env.PRIVATE_HTTP_QUALIFY_COMPILED === '1')(
  'reads a real private authority through the built standalone controller',
  async () => {
    const { reference } = await publication();
    const compiled =
      require('../../../agent-teams-controller/dist/internal/controlApiAuth.js') as typeof controller;
    expect(
      compiled.resolveControlAuthorities({ claudeDir: root }, {}, reference)[0].read().token
    ).toBe(key);
  }
);
