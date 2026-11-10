// @vitest-environment node
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SKILLS_LIST,
  SKILLS_PREVIEW_IMPORT,
  SKILLS_START_WATCHING,
  SKILLS_STOP_WATCHING,
} from '@preload/constants/ipcChannels';
import { afterEach, expect, test, vi } from 'vitest';

import { FileManagementCommandStore } from '../packages/legacy-agent-host/src/adapters/providers/FileManagementCommandStore';
import { createProviderManagementMethods } from '../packages/legacy-agent-host/src/composition/createProviderManagementMethods';
import { ProviderManagementCoordinator } from '../packages/legacy-agent-host/src/composition/ProviderManagementCoordinator';
import { ManagementResourceFence } from '../packages/legacy-agent-host/src/management/ManagementResourceFence';
import { captureSkillRoots } from '../packages/legacy-agent-host/src/skills/CapturedSkillRoots';
import { SkillCoordinator } from '../packages/legacy-agent-host/src/skills/SkillCoordinator';
import { captureSkillImportGrant } from '../packages/legacy-agent-host/src/skills/SkillImportGrant';
import {
  assertSkillTransportBudget,
  SKILL_IMPORT_LIMITS,
  skillDigest,
} from '../packages/legacy-agent-host/src/skills/skillPolicy';
import { captureProviderManagement } from '../src/features/agent-backend/main/infrastructure/CapturedProviderManagement';
import { initializeSkillsHandlers, registerSkillsHandlers } from '../src/main/ipc/skills';
import { CapturedSkills } from '../src/main/services/extensions/skills/CapturedSkills';
import { CapturedSkillsCache } from '../src/main/services/extensions/skills/CapturedSkillsCache';
import { CapturedSkillsCollection } from '../src/main/services/extensions/skills/CapturedSkillsCollection';
import { SkillsWatcherService } from '../src/main/services/extensions/skills/SkillsWatcherService';

import type { JsonValue } from '../packages/legacy-agent-host/src/contracts';
import type { StoredManagementCommand } from '../packages/legacy-agent-host/src/management/commandRecords';
import type {
  ClaudeManagementProfile,
  CodexManagementProfile,
} from '../packages/legacy-agent-host/src/management/profile';
import type { SkillsCatalogService } from '../src/main/services/extensions/skills/SkillsCatalogService';
import type { SkillsMutationService } from '../src/main/services/extensions/skills/SkillsMutationService';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const md = (name = 'demo') => `---\nname: ${name}\ndescription: TEST skill\n---\nTEST body\n`;
function fixture(
  options: {
    beforeEffect?(): Promise<void>;
    storeWrite?(record: StoredManagementCommand): void;
    afterRoute?(method: string, result: unknown): void;
  } = {}
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-m15-skills-')));
  roots.push(root);
  const home = join(root, 'home'),
    cwd = join(root, 'project'),
    config = join(root, 'claude-config'),
    storage = join(root, 'store');
  for (const path of [home, cwd, config, storage]) mkdirSync(path, { mode: 0o700 });
  const profile: ClaudeManagementProfile = {
    provider: 'claude',
    profileId: 'TEST-profile',
    configRevision: 'TEST-revision',
    accountBinding: 'TEST-account',
    sdkRevision: '0.3.305',
    configNamespace: 'custom-directory',
    timeoutMs: 1000,
    cwd,
    environment: { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: '/usr/bin:/bin' },
    executable: { path: '/TEST-not-executed', sha256: 'a'.repeat(64) },
  };
  let hostCurrent = true,
    foreground = true;
  const assertCurrent = () => {
    if (!hostCurrent) throw new Error('TEST original writer revoked');
  };
  const store = new FileManagementCommandStore(storage);
  const wrapped = {
    read: (id: string) => store.read(id),
    list: () => store.list(),
    write(record: StoredManagementCommand) {
      options.storeWrite?.(record);
      store.write(record);
    },
  };
  const target = {
    profileId: profile.profileId,
    configRevision: profile.configRevision,
    selectionDigest: 'b'.repeat(64),
    resourceId: 'c'.repeat(64),
  };
  const fence = new ManagementResourceFence(store.list());
  const coordinator = new SkillCoordinator([profile], {
    store: wrapped,
    fence,
    assertCurrent,
    managementTarget(id, revision) {
      assertCurrent();
      assert.equal(id, target.profileId);
      assert.equal(revision, target.configRevision);
      return target;
    },
    ...(options.beforeEffect ? { beforeEffect: options.beforeEffect } : {}),
  });
  const capture = (
    scope: 'user' | 'project' = 'user',
    rootKind: 'claude' | 'agents' | 'cursor' = 'claude'
  ) =>
    coordinator.capture({
      profileId: profile.profileId,
      configRevision: profile.configRevision,
      scope,
      rootKind,
    });
  const payload = (captured = capture()) => ({
    profileId: captured.profileId,
    configRevision: captured.configRevision,
    targetId: captured.targetId,
    scope: captured.scope,
    rootKind: captured.rootKind,
  });
  let loseNextMutationReply = false;
  const calls: string[] = [];
  const owner = captureProviderManagement({
    targetId: 'd'.repeat(64),
    profileId: profile.profileId,
    configRevision: profile.configRevision,
    ownerAvailable: () => hostCurrent,
    foregroundCurrent: () => foreground,
    start: async () => {},
    client: {
      async request(method, raw) {
        calls.push(method);
        const input = raw as Record<string, unknown>;
        const route = method.slice('management.skills.'.length);
        let result: unknown;
        if (route === 'trash.finish') result = coordinator.finishTrash(input);
        else if (route === 'capture') result = coordinator.capture(input);
        else if (route === 'read') result = coordinator.read(input);
        else if (route === 'preview') result = coordinator.preview(input);
        else if (route === 'pending') result = coordinator.pending(input);
        else if (route === 'lookup') result = coordinator.lookup(input);
        else if (route === 'mutate') {
          result = await coordinator.mutate(input);
          if (loseNextMutationReply) {
            loseNextMutationReply = false;
            throw new Error('TEST lost original response');
          }
        } else throw new Error('TEST unexpected method');
        options.afterRoute?.(route, result);
        return { ok: true, value: result } as JsonValue;
      },
    },
  });
  const main = (
    trashItem: (path: string) => Promise<void> = async () => {
      throw new Error('No OS Trash in filesystem tests');
    }
  ) =>
    CapturedSkills.capture({
      owner,
      contextId: 'TEST-original-sender-context',
      scope: 'user',
      rootKind: 'claude',
      trashItem,
    });
  return {
    root,
    home,
    cwd,
    config,
    storage,
    profile,
    coordinator,
    store,
    target,
    capture,
    payload,
    owner,
    main,
    calls,
    revokeHost() {
      hostCurrent = false;
    },
    restoreHost() {
      hostCurrent = true;
    },
    switchForeground() {
      foreground = false;
    },
    loseMutationReply() {
      loseNextMutationReply = true;
    },
  };
}
function source(root: string) {
  const path = join(root, 'source');
  mkdirSync(join(path, 'assets'), { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), md());
  writeFileSync(join(path, 'assets/picture.bin'), Buffer.from([0, 1, 254]));
  writeFileSync(join(path, '.secret'), 'TEST hidden');
  return path;
}
const classifier = (bytes: Buffer) => bytes.includes(0);
function grant(f: ReturnType<typeof fixture>, path: string) {
  return captureSkillImportGrant({
    sourceDir: path,
    originalContext: 'TEST-original-context',
    assertCurrent: () => {
      if (!f.owner.isCurrent()) throw new Error('TEST original context revoked');
    },
    isBinary: classifier,
  });
}

test('SDK-free absent-root preview performs no mkdir; actual install preserves unmanaged files and managed policy', async () => {
  const f = fixture(),
    target = f.capture(),
    selection = f.payload(target);
  const command = {
    action: 'upsert' as const,
    folderName: 'demo',
    files: [{ relativePath: 'SKILL.md', content: md() }],
  };
  const preview = f.coordinator.preview({ ...selection, command });
  assert.equal(existsSync(target.rootPath), false);
  assert.equal([...f.store.list()].length, 0);
  const result = await f.coordinator.mutate({
    ...selection,
    commandId: 'TEST-create',
    reviewPlanId: preview.planId,
    command,
  });
  assert.equal(result.receipt.phase, 'completed');
  assert.equal(readFileSync(join(target.rootPath, 'demo/SKILL.md'), 'utf8'), md());
  mkdirSync(join(target.rootPath, 'demo/scripts'));
  writeFileSync(join(target.rootPath, 'demo/scripts/old.sh'), 'TEST obsolete');
  writeFileSync(join(target.rootPath, 'demo/keep.txt'), 'TEST unmanaged');
  const next = f.coordinator.preview({ ...selection, command });
  assert.equal(next.summary.deleted, 1);
  const updated = await f.coordinator.mutate({
    ...selection,
    commandId: 'TEST-update',
    reviewPlanId: next.planId,
    command,
  });
  assert.equal(updated.receipt.phase, 'completed');
  assert.equal(existsSync(join(target.rootPath, 'demo/scripts/old.sh')), false);
  assert.equal(readFileSync(join(target.rootPath, 'demo/keep.txt'), 'utf8'), 'TEST unmanaged');
  const backup = join(
    target.rootPath,
    '._desktop-skill-' + skillDigest('TEST-update'),
    'original/scripts/old.sh'
  );
  assert.equal(readFileSync(backup, 'utf8'), 'TEST obsolete');
});

test('staged edits preserve empty unmanaged directories while cleaning empty managed trees', async () => {
  const f = fixture();
  const skill = join(f.config, 'skills/demo');
  mkdirSync(join(skill, 'empty-sidecar'), { recursive: true });
  mkdirSync(join(skill, 'scripts'));
  writeFileSync(join(skill, 'SKILL.md'), md());
  const main = await f.main();
  const request = {
    scope: 'user' as const,
    rootKind: 'claude' as const,
    folderName: 'demo',
    files: [{ relativePath: 'SKILL.md', content: md('changed') }],
  };
  const preview = await main.previewUpsert(request);
  await main.applyUpsert({ ...request, reviewPlanId: preview.planId });
  assert.equal(existsSync(join(skill, 'empty-sidecar')), true);
  assert.equal(existsSync(join(skill, 'scripts')), false);
});

test('four existing rootKinds use explicit matching profile/config and exact project scope', () => {
  const f = fixture();
  assert.equal(f.capture().rootPath, join(f.config, 'skills'));
  assert.equal(f.capture('user', 'agents').rootPath, join(f.home, '.agents/skills'));
  assert.equal(f.capture('user', 'cursor').rootPath, join(f.home, '.cursor/skills'));
  assert.equal(f.capture('project', 'agents').rootPath, join(f.cwd, '.agents/skills'));
  assert.throws(() => captureSkillRoots(f.profile, { scope: 'user', rootKind: 'codex' }, () => {}));
  const codexHome = join(f.root, 'codex-home');
  mkdirSync(codexHome);
  const codex: CodexManagementProfile = {
    provider: 'codex',
    profileId: 'TEST-codex',
    configRevision: 'TEST-revision',
    accountBinding: 'TEST-account',
    protocolRevision: '0.162.0',
    timeoutMs: 1000,
    cwd: f.cwd,
    environment: { HOME: f.home, CODEX_HOME: codexHome },
    executable: f.profile.executable,
  };
  assert.equal(
    captureSkillRoots(codex, { scope: 'user', rootKind: 'codex' }, () => {}).rootPath,
    join(codexHome, 'skills')
  );
});

test('actual binary import bundle binds bytes, skips hidden files and rejects source or original inode changes after review', async () => {
  const f = fixture(),
    path = source(f.root),
    original = grant(f, path),
    selection = f.payload();
  assert.equal(original.bundle.hiddenEntriesSkipped, 1);
  assert.equal(original.bundle.files.length, 2);
  const command = { action: 'import' as const, folderName: 'demo', bundle: original.bundle };
  const preview = f.coordinator.preview({ ...selection, command });
  assert.equal(existsSync(join(f.config, 'skills')), false);
  writeFileSync(join(path, 'assets/picture.bin'), Buffer.from([0, 9, 254]));
  assert.throws(() => original.assertCurrent(), /source changed/);
  const changed = grant(f, path);
  await assert.rejects(
    f.coordinator.mutate({
      ...selection,
      commandId: 'TEST-import',
      reviewPlanId: preview.planId,
      command: { ...command, bundle: changed.bundle },
    }),
    /changed after review/
  );
  assert.equal([...f.store.list()].length, 0);
  assert.equal(existsSync(join(f.config, 'skills')), false);
  const replacement = join(f.root, 'source-replacement');
  renameSync(path, replacement);
  mkdirSync(path);
  writeFileSync(join(path, 'SKILL.md'), md());
  assert.throws(() => changed.assertCurrent(), /source changed/);
});

test('source grant rejects symlink traversal and source context revoke without target writes', () => {
  const f = fixture(),
    path = source(f.root),
    outside = join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'TEST untouched');
  symlinkSync(outside, join(path, 'link'));
  assert.throws(() => grant(f, path), /symbolic links/);
  rmSync(join(path, 'link'));
  f.switchForeground();
  assert.throws(() => grant(f, path), /revoked/);
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'TEST untouched');
  assert.equal(existsSync(join(f.config, 'skills')), false);
});

test('the complete old 10MiB boundary and 200 files remain valid; one byte/file beyond refuses', () => {
  const f = fixture(),
    path = join(f.root, 'large-source');
  mkdirSync(path);
  writeFileSync(join(path, 'SKILL.md'), 'x');
  writeFileSync(join(path, 'body.bin'), Buffer.alloc(SKILL_IMPORT_LIMITS.bytes - 1));
  assert.equal(grant(f, path).bundle.files.length, 2);
  writeFileSync(join(path, 'body.bin'), Buffer.alloc(SKILL_IMPORT_LIMITS.bytes));
  assert.throws(() => grant(f, path), /too large/);
  rmSync(join(path, 'body.bin'));
  for (let i = 0; i < 199; i++) writeFileSync(join(path, 'file-' + i), 'TEST');
  assert.equal(grant(f, path).bundle.files.length, 200);
  writeFileSync(join(path, 'extra'), 'TEST');
  assert.throws(() => grant(f, path), /too many files/);
  assert.throws(
    () => assertSkillTransportBudget({ value: '\u0001'.repeat(6 * 1024 * 1024) }),
    /encoded 32 MiB/
  );
});

test('review cannot escape roots; existing descendant and absent-ancestor replacement is refused', async () => {
  const f = fixture(),
    target = f.capture('user', 'agents'),
    selection = f.payload(target);
  const command = {
    action: 'upsert' as const,
    folderName: 'demo',
    files: [{ relativePath: '../outside', content: 'TEST unsafe' }],
  };
  assert.throws(() => f.coordinator.preview({ ...selection, command }), /relative skill path/);
  mkdirSync(join(f.home, '.agents')); // Was absent at the actual captured target; must not adopt it.
  assert.throws(
    () =>
      f.coordinator.preview({
        ...selection,
        command: { ...command, files: [{ relativePath: 'SKILL.md', content: md() }] },
      }),
    /root changed/
  );
  assert.equal([...f.store.list()].length, 0);
});

test('real post-admission context/source-root changes fence effects and keep original intent held', async () => {
  const f = fixture({
    beforeEffect: async () => {
      f.revokeHost();
    },
  });
  const selection = f.payload(),
    command = {
      action: 'upsert' as const,
      folderName: 'demo',
      files: [{ relativePath: 'SKILL.md', content: md() }],
    };
  const preview = f.coordinator.preview({ ...selection, command });
  const result = await f.coordinator.mutate({
    ...selection,
    commandId: 'TEST-revoked',
    reviewPlanId: preview.planId,
    command,
  });
  assert.equal(result.receipt.phase, 'held');
  assert.equal(existsSync(join(f.config, 'skills')), false);
  f.restoreHost();
  assert.equal(f.coordinator.lookup({ ...selection, commandId: 'TEST-revoked' })?.phase, 'held');
  assert.equal([...f.store.list()].length, 1);
});

test('a lost final journal publication never replays a completed filesystem effect or replaces the original intent', async () => {
  const f = fixture({
    storeWrite(record) {
      if (record.kind === 'skill.mutation' && record.phase === 'completed')
        throw new Error('TEST publication lost');
    },
  });
  const selection = f.payload(),
    command = {
      action: 'upsert' as const,
      folderName: 'demo',
      files: [{ relativePath: 'SKILL.md', content: md() }],
    };
  const preview = f.coordinator.preview({ ...selection, command });
  const result = await f.coordinator.mutate({
    ...selection,
    commandId: 'TEST-original',
    reviewPlanId: preview.planId,
    command,
  });
  assert.equal(result.receipt.phase, 'held');
  assert.equal(readFileSync(join(f.config, 'skills/demo/SKILL.md'), 'utf8'), md());
  writeFileSync(join(f.config, 'skills/demo/SKILL.md'), 'TEST replacement');
  const replay = await f.coordinator.mutate({
    ...selection,
    commandId: 'TEST-original',
    reviewPlanId: preview.planId,
    command,
  });
  assert.equal(replay.receipt.phase, 'held');
  assert.equal(readFileSync(join(f.config, 'skills/demo/SKILL.md'), 'utf8'), 'TEST replacement');
  const pending = f.coordinator.pending({ ...selection, command });
  assert.equal(pending?.commandId, 'TEST-original');
  assert.equal([...f.store.list()].length, 1);
});

test('actual Main adapter recovers only original lost reply, maps original metadata, and imports immutable source bytes', async () => {
  const f = fixture(),
    main = await f.main(),
    request = {
      scope: 'user' as const,
      rootKind: 'claude' as const,
      folderName: 'demo',
      files: [{ relativePath: 'SKILL.md', content: md() }],
    };
  const preview = await main.previewUpsert(request);
  f.loseMutationReply();
  const detail = await main.applyUpsert({ ...request, reviewPlanId: preview.planId });
  assert.equal(detail?.item.name, 'demo');
  assert.equal(f.calls.filter((call) => call === 'management.skills.mutate').length, 1);
  assert.equal(f.calls.filter((call) => call === 'management.skills.lookup').length, 1);
  const path = source(f.root),
    importRequest = {
      sourceDir: path,
      scope: 'user' as const,
      rootKind: 'claude' as const,
      folderName: 'demo',
    };
  const imported = await main.previewImport(importRequest);
  const importedDetail = await main.applyImport({
    ...importRequest,
    reviewPlanId: imported.planId,
  });
  assert.equal(importedDetail?.assetFiles[0], 'picture.bin');
  assert.deepEqual(
    readFileSync(join(f.config, 'skills/demo/assets/picture.bin')),
    Buffer.from([0, 1, 254])
  );
  assert.equal(existsSync(join(f.config, 'skills/demo/.secret')), false);
});

test('Main import rejects changed source-field or context after await; caller never chooses another target', async () => {
  const f = fixture(),
    main = await f.main(),
    path = source(f.root);
  const request = {
    sourceDir: path,
    scope: 'user' as const,
    rootKind: 'claude' as const,
    folderName: 'demo',
  };
  const preview = await main.previewImport(request);
  await assert.rejects(
    main.applyImport({
      ...request,
      sourceDir: join(f.root, 'other'),
      reviewPlanId: preview.planId,
    }),
    /original skill import/
  );
  writeFileSync(join(path, 'SKILL.md'), 'TEST changed source');
  await assert.rejects(
    main.applyImport({ ...request, reviewPlanId: preview.planId }),
    /source changed/
  );
  assert.equal(existsSync(join(f.config, 'skills')), false);
  await assert.rejects(
    main.previewUpsert({
      scope: 'project',
      rootKind: 'claude',
      projectPath: f.cwd,
      folderName: 'demo',
      files: [{ relativePath: 'SKILL.md', content: md() }],
    }),
    /scope changed/
  );
});

test('Trash stages only the original directory; replacement at old name survives exact native callback', async () => {
  const f = fixture(),
    nativeTrash = join(f.root, 'TEST-native-trash');
  mkdirSync(nativeTrash);
  let calls = 0;
  const main = await f.main(async (path) => {
    calls++;
    assert.equal(readFileSync(join(path, 'SKILL.md'), 'utf8'), md());
    mkdirSync(join(f.config, 'skills/demo'));
    writeFileSync(join(f.config, 'skills/demo/SKILL.md'), 'TEST new occupant');
    renameSync(path, join(nativeTrash, 'original')); // Native shell boundary is injected; actual FS custody is exercised.
  });
  const request = {
    scope: 'user' as const,
    rootKind: 'claude' as const,
    folderName: 'demo',
    files: [{ relativePath: 'SKILL.md', content: md() }],
  };
  const preview = await main.previewUpsert(request);
  await main.applyUpsert({ ...request, reviewPlanId: preview.planId });
  await main.getDetail(join(f.config, 'skills/demo'));
  await main.deleteSkill({ skillId: join(f.config, 'skills/demo') });
  assert.equal(calls, 1);
  assert.equal(readFileSync(join(nativeTrash, 'original/SKILL.md'), 'utf8'), md());
  assert.equal(readFileSync(join(f.config, 'skills/demo/SKILL.md'), 'utf8'), 'TEST new occupant');
  assert.equal(
    [...f.store.list()].filter((row) => row.kind === 'skill.mutation' && row.action === 'trash')[0]
      ?.phase,
    'completed'
  );
});

test('failed/uncertain OS Trash remains recoverable and held; absence alone cannot settle or dispatch again', async () => {
  const f = fixture();
  let calls = 0;
  const main = await f.main(async () => {
    calls++;
    throw new Error('TEST native outcome unknown');
  });
  const request = {
    scope: 'user' as const,
    rootKind: 'claude' as const,
    folderName: 'demo',
    files: [{ relativePath: 'SKILL.md', content: md() }],
  };
  const preview = await main.previewUpsert(request);
  await main.applyUpsert({ ...request, reviewPlanId: preview.planId });
  await assert.rejects(
    main.deleteSkill({ skillId: join(f.config, 'skills/demo') }),
    /OS Trash is unconfirmed/
  );
  const record = [...f.store.list()].find(
    (row) => row.kind === 'skill.mutation' && row.action === 'trash'
  );
  assert.equal(record?.kind, 'skill.mutation');
  if (!record || record.kind !== 'skill.mutation' || !record.trash)
    throw new Error('TEST missing original claim');
  assert.equal(readFileSync(join(record.trash.path, 'SKILL.md'), 'utf8'), md());
  renameSync(record.trash.path, join(f.root, 'TEST-unknown-destination'));
  const originalSelection = {
    profileId: record.profileId,
    configRevision: record.configRevision,
    targetId: record.targetId,
    scope: record.scope,
    rootKind: record.rootKind,
  };
  const receipt = f.coordinator.finishTrash({
    ...originalSelection,
    commandId: record.commandId,
    token: record.trash.token,
    nativeCompleted: false,
  });
  assert.equal(receipt.phase, 'held');
  assert.equal(calls, 1);
  const replay = await f.coordinator
    .mutate({
      ...originalSelection,
      commandId: record.commandId,
      reviewPlanId: preview.planId,
      command: { action: 'trash', folderName: 'demo', expectedIdentity: '0'.repeat(64) },
    })
    .catch(() => null);
  assert.equal(replay, null);
  assert.equal(calls, 1);
});

test('a foreground switch during native Trash preserves known original completion without repainting new context', async () => {
  const f = fixture(),
    nativeTrash = join(f.root, 'TEST-native-trash');
  mkdirSync(nativeTrash);
  const main = await f.main(async (path) => {
    renameSync(path, join(nativeTrash, 'original'));
    f.switchForeground();
  });
  const request = {
    scope: 'user' as const,
    rootKind: 'claude' as const,
    folderName: 'demo',
    files: [{ relativePath: 'SKILL.md', content: md() }],
  };
  const preview = await main.previewUpsert(request);
  await main.applyUpsert({ ...request, reviewPlanId: preview.planId });
  await assert.rejects(
    main.deleteSkill({ skillId: join(f.config, 'skills/demo') }),
    /selection changed/
  );
  assert.equal(
    [...f.store.list()].find((row) => row.kind === 'skill.mutation' && row.action === 'trash')
      ?.phase,
    'completed'
  );
  assert.equal(f.calls.filter((call) => call === 'management.skills.trash.finish').length, 1);
});

test('destination symlink injected after actual durable admission cannot redirect a write outside its captured root', async () => {
  const f = fixture({
    beforeEffect: async () => {
      renameSync(join(f.config, 'skills'), join(f.root, 'TEST-original-skills'));
      symlinkSync(join(f.root, 'TEST-outside'), join(f.config, 'skills'));
    },
  });
  mkdirSync(join(f.config, 'skills'));
  mkdirSync(join(f.root, 'TEST-outside'));
  writeFileSync(join(f.root, 'TEST-outside/sentinel'), 'TEST untouched');
  const selection = f.payload(),
    command = {
      action: 'upsert' as const,
      folderName: 'demo',
      files: [{ relativePath: 'SKILL.md', content: md() }],
    };
  const preview = f.coordinator.preview({ ...selection, command });
  const result = await f.coordinator.mutate({
    ...selection,
    commandId: 'TEST-symlink',
    reviewPlanId: preview.planId,
    command,
  });
  assert.equal(result.receipt.phase, 'held');
  assert.deepEqual(readdirSync(join(f.root, 'TEST-outside')), ['sentinel']);
  assert.equal(readFileSync(join(f.root, 'TEST-outside/sentinel'), 'utf8'), 'TEST untouched');
});

test('Main revalidates the original source after an awaited pending lookup and before actual write dispatch', async () => {
  let sourcePath = '',
    changed = false;
  const f = fixture({
    afterRoute(method) {
      if (method === 'pending' && !changed) {
        changed = true;
        writeFileSync(join(sourcePath, 'SKILL.md'), 'TEST changed while awaiting');
      }
    },
  });
  sourcePath = source(f.root);
  const main = await f.main();
  const request = {
    sourceDir: sourcePath,
    scope: 'user' as const,
    rootKind: 'claude' as const,
    folderName: 'demo',
  };
  const preview = await main.previewImport(request);
  await assert.rejects(
    main.applyImport({ ...request, reviewPlanId: preview.planId }),
    /source changed/
  );
  assert.equal(f.calls.filter((call) => call === 'management.skills.mutate').length, 0);
  assert.equal([...f.store.list()].length, 0);
  assert.equal(existsSync(join(f.config, 'skills')), false);
});

test('a lost original Trash preparation reply retains staged original bytes and never invokes or reissues native Trash', async () => {
  const f = fixture();
  let calls = 0;
  const main = await f.main(async () => {
    calls++;
  });
  const request = {
    scope: 'user' as const,
    rootKind: 'claude' as const,
    folderName: 'demo',
    files: [{ relativePath: 'SKILL.md', content: md() }],
  };
  const preview = await main.previewUpsert(request);
  await main.applyUpsert({ ...request, reviewPlanId: preview.planId });
  f.loseMutationReply();
  await assert.rejects(
    main.deleteSkill({ skillId: join(f.config, 'skills/demo') }),
    /original skill change is unconfirmed/
  );
  const saved = [...f.store.list()].find(
    (row) => row.kind === 'skill.mutation' && row.action === 'trash'
  );
  if (!saved || saved.kind !== 'skill.mutation' || !saved.trash)
    throw new Error('TEST missing staged original');
  assert.equal(calls, 0);
  assert.equal(readFileSync(join(saved.trash.path, 'SKILL.md'), 'utf8'), md());
  await assert.rejects(main.deleteSkill({ skillId: join(f.config, 'skills/demo') }));
  assert.equal(calls, 0);
  assert.equal(
    [...f.store.list()].filter((row) => row.kind === 'skill.mutation' && row.action === 'trash')
      .length,
    1
  );
});

test('conflicting desired file/directory layout preserves original user bytes in place on a staged install failure', async () => {
  const f = fixture(),
    selection = f.payload(),
    first = {
      action: 'upsert' as const,
      folderName: 'demo',
      files: [{ relativePath: 'SKILL.md', content: md() }],
    };
  const preview = f.coordinator.preview({ ...selection, command: first });
  await f.coordinator.mutate({
    ...selection,
    commandId: 'TEST-first',
    reviewPlanId: preview.planId,
    command: first,
  });
  writeFileSync(join(f.config, 'skills/demo/unmanaged.txt'), 'TEST original user bytes');
  const command = {
    ...first,
    files: [
      ...first.files,
      { relativePath: 'scripts', content: 'TEST file' },
      { relativePath: 'scripts/run.sh', content: 'TEST child' },
    ],
  };
  const next = f.coordinator.preview({ ...selection, command });
  const result = await f.coordinator.mutate({
    ...selection,
    commandId: 'TEST-conflicting-layout',
    reviewPlanId: next.planId,
    command,
  });
  assert.equal(result.receipt.phase, 'held');
  assert.equal(
    readFileSync(join(f.config, 'skills/demo/unmanaged.txt'), 'utf8'),
    'TEST original user bytes'
  );
  assert.equal(readFileSync(join(f.config, 'skills/demo/SKILL.md'), 'utf8'), md());
});

function ipcFixture(capture?: Parameters<typeof initializeSkillsHandlers>[3]) {
  const calls: unknown[] = [],
    handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  initializeSkillsHandlers(
    {
      async list(path: string) {
        calls.push(['legacy-list', path]);
        return [];
      },
    } as unknown as SkillsCatalogService,
    {
      async previewImport(request: unknown) {
        calls.push(['legacy-import', request]);
        return { planId: 'TEST-legacy' };
      },
    } as unknown as SkillsMutationService,
    {
      async start(path: string) {
        calls.push(['legacy-watch', path]);
        return 'TEST-legacy-watch';
      },
      startCaptured(roots: unknown[], assertCurrent: () => void) {
        assertCurrent();
        calls.push(['captured-watch', roots]);
        return 'TEST-captured-watch';
      },
      stop(id: string) {
        calls.push(['legacy-stop', id]);
      },
    } as unknown as SkillsWatcherService,
    capture
  );
  registerSkillsHandlers({
    handle(channel: string, handler: (...args: unknown[]) => Promise<unknown>) {
      handlers.set(channel, handler);
    },
  } as unknown as IpcMain);
  const event = { sender: { id: 991 } } as IpcMainInvokeEvent;
  return {
    calls,
    invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args),
  };
}

test('existing Skills IPC keeps exact legacy route when capture explicitly returns undefined', async () => {
  const request = { sourceDir: '/TEST-existing-source', scope: 'user', rootKind: 'agents' };
  const ipc = ipcFixture(() => undefined);
  assert.deepEqual(await ipc.invoke(SKILLS_LIST, '/TEST-existing-project'), {
    success: true,
    data: [],
  });
  assert.deepEqual(await ipc.invoke(SKILLS_PREVIEW_IMPORT, request), {
    success: true,
    data: { planId: 'TEST-legacy' },
  });
  assert.deepEqual(ipc.calls, [
    ['legacy-list', '/TEST-existing-project'],
    ['legacy-import', request],
  ]);
});

test('captured Skills IPC rejects unavailable context without invoking ambient legacy paths', async () => {
  const ipc = ipcFixture(async () => {
    throw new Error('TEST original captured context unavailable');
  });
  assert.deepEqual(
    await ipc.invoke(SKILLS_PREVIEW_IMPORT, {
      sourceDir: '/TEST-never-read',
      scope: 'user',
      rootKind: 'claude',
    }),
    { success: false, error: 'TEST original captured context unavailable' }
  );
  assert.deepEqual(ipc.calls, []);
  expect(console.error).toHaveBeenCalledExactlyOnceWith(
    '[IPC:skills]',
    'skillsPreviewImport failed',
    expect.objectContaining({ message: 'TEST original captured context unavailable' })
  );
  vi.mocked(console.error).mockClear();
});

test('captured Skills collection fences awaited response and scopes existing watching to exact original roots', async () => {
  let shouldSwitch = false;
  const f = fixture({
    afterRoute(method) {
      if (shouldSwitch && method === 'read') f.switchForeground();
    },
  });
  const root = await f.main(),
    collection = new CapturedSkillsCollection([root], () => f.owner.isCurrent());
  const ipc = ipcFixture(async () => collection);
  assert.deepEqual(await ipc.invoke(SKILLS_START_WATCHING), {
    success: true,
    data: 'TEST-captured-watch',
  });
  assert.deepEqual(ipc.calls.shift(), [
    'captured-watch',
    [{ scope: 'user', rootKind: 'claude', projectRoot: null, rootPath: root.target.rootPath }],
  ]);
  await ipc.invoke(SKILLS_STOP_WATCHING, 'TEST-original-watch-id');
  assert.deepEqual(ipc.calls, [['legacy-stop', 'TEST-original-watch-id']]);
  shouldSwitch = true;
  const result = (await ipc.invoke(SKILLS_LIST)) as { success: boolean };
  assert.equal(result.success, false);
  assert.deepEqual(ipc.calls, [['legacy-stop', 'TEST-original-watch-id']]);
  expect(console.error).toHaveBeenCalledExactlyOnceWith(
    '[IPC:skills]',
    'skillsList failed',
    expect.objectContaining({ message: 'Backend routing: forbidden' })
  );
  vi.mocked(console.error).mockClear();
});

test('cached IPC capture retains original import bytes across preview/apply and never recaptures failed original roots', async () => {
  const f = fixture(),
    cache = new CapturedSkillsCache();
  let captures = 0;
  const capture = () =>
    cache.capture(
      'TEST-context',
      () => f.owner.isCurrent(),
      async () => {
        captures++;
        return new CapturedSkillsCollection([await f.main()], () => f.owner.isCurrent());
      }
    );
  const sourceDir = join(f.root, 'import');
  mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, 'SKILL.md'), md());
  const request = { scope: 'user' as const, rootKind: 'claude' as const, sourceDir };
  const preview = await (await capture()).previewImport(request);
  assert.equal(
    (await (await capture()).applyImport({ ...request, reviewPlanId: preview.planId }))?.item
      .folderName,
    'import'
  );
  assert.equal(captures, 1);
  f.switchForeground();
  assert.throws(capture, /context changed/u);
  let attempts = 0;
  const failed = () =>
    cache.capture(
      'TEST-failed',
      () => true,
      async () => {
        attempts++;
        throw new Error('TEST original root changed');
      }
    );
  await assert.rejects(failed(), /original root changed/u);
  await assert.rejects(failed(), /original root changed/u);
  assert.equal(attempts, 1);
});

test('existing real watcher observes only captured sandbox roots and suppresses queued changes after context revoke', async () => {
  const f = fixture(),
    rootPath = join(f.config, 'skills');
  mkdirSync(rootPath);
  const file = join(rootPath, 'TEST-watch.md');
  writeFileSync(file, 'initial');
  let current = true;
  const watcher = new SkillsWatcherService({
    resolve() {
      throw new Error('TEST ambient roots must never resolve');
    },
  });
  const events: unknown[] = [];
  watcher.setEmitter((event) => events.push(event));
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await watcher.startCaptured(
      [{ scope: 'user', rootKind: 'claude', rootPath, projectRoot: null }],
      () => {
        if (!current) throw new Error('TEST context revoked');
      }
    );
    await pause(450);
    writeFileSync(file, 'observed original');
    const deadline = Date.now() + 3000;
    while (!events.length && Date.now() < deadline) await pause(50);
    assert.equal(events.length, 1);
    events.length = 0;
    writeFileSync(file, 'must not publish after revoke');
    await pause(50);
    current = false;
    await pause(700);
    assert.deepEqual(events, []);
  } finally {
    await watcher.stopAll();
  }
});

test('actual management composition shares durable Skills admission with credentials and never returns a Trash dispatch on lookup', async () => {
  const f = fixture();
  const root = join(f.config, 'skills');
  mkdirSync(join(root, 'demo'), { recursive: true });
  writeFileSync(join(root, 'demo/SKILL.md'), md());
  let sealed = false;
  const management = new ProviderManagementCoordinator(
    [f.profile],
    () => {
      if (sealed) throw new Error('TEST sealed');
    },
    f.storage
  );
  const routes = createProviderManagementMethods(management, () => sealed);
  const call = async (operation: string, input: unknown) => {
    const result = await routes['management.skills.' + operation]!.handle(input as JsonValue, {
      requestId: 'TEST-request',
      signal: new AbortController().signal,
    });
    assert.equal((result as { ok: boolean }).ok, true);
    return (result as { value: unknown }).value;
  };
  try {
    const target = (await call('capture', {
      profileId: f.profile.profileId,
      configRevision: f.profile.configRevision,
      scope: 'user',
      rootKind: 'claude',
    })) as ReturnType<SkillCoordinator['capture']>;
    const selected = {
      profileId: target.profileId,
      configRevision: target.configRevision,
      targetId: target.targetId,
      scope: target.scope,
      rootKind: target.rootKind,
    };
    const read = (await call('read', selected)) as ReturnType<SkillCoordinator['read']>;
    const command = {
      action: 'trash' as const,
      folderName: 'demo',
      expectedIdentity: read.items[0]!.identity,
    };
    const preview = (await call('preview', { ...selected, command })) as { planId: string };
    assert.deepEqual([...f.store.list()], []);
    const result = (await call('mutate', {
      ...selected,
      commandId: 'TEST-composed-trash',
      reviewPlanId: preview.planId,
      command,
    })) as Awaited<ReturnType<SkillCoordinator['mutate']>>;
    assert.equal(result.receipt.phase, 'held');
    assert.ok(result.nativeTrash);
    assert.equal([...f.store.list()][0]!.kind, 'skill.mutation');
    await assert.rejects(
      management.credentials.execute({
        commandId: 'TEST-must-not-run-provider',
        profileId: f.profile.profileId,
        configRevision: f.profile.configRevision,
        providerId: 'anthropic',
        kind: 'credential.forget',
      }),
      /busy|held/u
    );
    const lookup = await call('lookup', { ...selected, commandId: 'TEST-composed-trash' });
    assert.deepEqual(lookup, result.receipt);
    assert.equal('nativeTrash' in (lookup as object), false);
    assert.equal(routes['management.skills.mutate']!.lane, 'work');
    assert.equal(routes['management.skills.trash.finish']!.lane, 'control');
    sealed = true;
    assert.deepEqual(
      await routes['management.skills.capture']!.handle(
        {},
        { requestId: 'TEST-request', signal: new AbortController().signal }
      ),
      { ok: false, code: 'unavailable' }
    );
  } finally {
    await management.close();
  }
});
