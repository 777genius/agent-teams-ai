import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';

export const LEGACY_IMPORT_TEAM = 'test-stopped-legacy';
export const LEGACY_IMPORT_LABEL = 'TEST never-launched legacy saved Team';
export interface StoppedImportUiSeed {
  sourceKind?: 'captured-stopped-solo';
  priorRun?: { path: string; sha256: string };
  teamName: string;
  displayName: string;
  sourceCardLabel: string;
  taskId: string;
  linkedTaskId: string;
  externalTaskId: string;
  missingTaskId: string;
  blobPath: string;
  sourceMessage: {
    messageId: string;
    image: {
      id: string;
      filename: string;
      mimeType: string;
      path: string;
      size: number;
      sha256: string;
    };
    file: {
      id: string;
      filename: string;
      mimeType: string;
      path: string;
      size: number;
      sha256: string;
    };
  };
  savedSettings: {
    cwd: string;
    providerId: string;
    model: string;
    effort: string;
    fastMode: string;
    prompt: string;
    skipPermissions: boolean;
    syncModelsWithLead: boolean;
    limitContext: boolean;
  };
  roots: string[];
  before: { path: string; sha256: string; sizeBytes: number }[];
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = async (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });

/** Hash only explicitly isolated legacy source roots, never another project or user storage. */
export async function stoppedImportSourceBytes(root: string, roots: readonly string[]) {
  assert.equal(await realpath(root), root);
  assert.match(basename(root), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
  const files: { path: string; sha256: string; sizeBytes: number }[] = [];
  for (const directory of roots) {
    assert.ok(directory.startsWith(root + '/') && !directory.includes('/../'));
    assert.equal(await realpath(directory), directory);
    const entries = await readdir(directory, {
      recursive: true,
      withFileTypes: true,
    });
    assert.ok(entries.length <= 128);
    for (const entry of entries) {
      assert.ok(!entry.isSymbolicLink());
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      const bytes = await readFile(path);
      assert.ok(bytes.length <= 1024 * 1024);
      files.push({ path, sha256: digest(bytes), sizeBytes: bytes.length });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Synthetic saved legacy records; optional prior-run setup uses actual captured TEST child Stop. */
export async function prepareDesktopStoppedImport(
  root: string,
  options: { priorRun?: boolean; node?: string } = {}
): Promise<void> {
  assert.equal(await realpath(root), root);
  assert.match(basename(root), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
  const team = join(root, 'claude/teams', LEGACY_IMPORT_TEAM);
  const tasks = join(root, 'claude/tasks', LEGACY_IMPORT_TEAM);
  const attachments = join(root, 'userData/data/attachments', LEGACY_IMPORT_TEAM);
  const taskAttachments = join(root, 'userData/data/task-attachments', LEGACY_IMPORT_TEAM);
  for (const directory of [team, tasks, attachments, taskAttachments])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  const savedSettings = {
    cwd: join(root, 'workspace'),
    providerId: 'anthropic',
    model: 'claude-sonnet-4-6',
    effort: 'low',
    fastMode: 'off',
    prompt: options.priorRun
      ? 'TEST prior-run saved prompt'
      : 'TEST imported saved prompt; never submit this prompt',
    skipPermissions: false,
    syncModelsWithLead: false,
    limitContext: true,
  };
  // Exact legacy createTeamConfig save-only output: no config.json or persisted synthetic lead.
  await json(join(team, 'team.meta.json'), {
    version: 1,
    ...savedSettings,
    displayName: options.priorRun ? 'TEST captured-stopped solo legacy Team' : LEGACY_IMPORT_LABEL,
    description: 'TEST configured data without native launch history',
    createdAt: 1792713600000,
  });
  await json(join(team, 'members.meta.json'), {
    version: 1,
    members: [
      {
        name: 'alice',
        agentType: 'general-purpose',
        model: savedSettings.model,
        providerId: 'anthropic',
        providerBackendId: 'cli-sdk',
        effort: 'low',
        fastMode: 'off',
        role: 'TEST developer',
        workflow: 'TEST saved member workflow',
        color: 'blue',
        joinedAt: 1792713600000,
      },
    ],
  });
  const taskId = 'TEST-legacy-task-a',
    linkedTaskId = 'TEST-legacy-task-b';
  const internal = {
    taskId: linkedTaskId,
    displayId: '18',
    teamName: LEGACY_IMPORT_TEAM,
  };
  const external = {
    taskId: 'TEST-external-task',
    displayId: '99',
    teamName: 'test-desktop-backend',
  };
  const missing = {
    taskId: 'TEST-missing-task',
    displayId: '100',
    teamName: LEGACY_IMPORT_TEAM,
  };
  const href = (ref: typeof internal) =>
    `task://${ref.taskId}?team=${encodeURIComponent(ref.teamName)}&display=${ref.displayId}`;
  await mkdir(join(taskAttachments, taskId), { mode: 0o700 });
  const blobPath = join(taskAttachments, taskId, 'TEST-task-blob--saved-note.txt');
  const blob = 'TEST original task attachment bytes\n';
  await writeFile(blobPath, blob, { mode: 0o600, flag: 'wx' });
  const messageId = 'TEST-legacy-source-message';
  await mkdir(join(attachments, messageId), { mode: 0o700 });
  const sourceBytes = {
    image: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=',
      'base64'
    ),
    file: Buffer.from('TEST original source message download bytes\n'),
  };
  const sourceMessage = {
    messageId,
    image: {
      id: 'TEST-source-image',
      filename: 'source-original.png',
      mimeType: 'image/png',
      path: join(attachments, messageId, 'TEST-source-image--source-original.png'),
      size: sourceBytes.image.length,
      sha256: digest(sourceBytes.image),
    },
    file: {
      id: 'TEST-source-file',
      filename: 'source-original.txt',
      mimeType: 'text/plain',
      path: join(attachments, messageId, 'TEST-source-file--source-original.txt'),
      size: sourceBytes.file.length,
      sha256: digest(sourceBytes.file),
    },
  };
  for (const key of ['image', 'file'] as const)
    await writeFile(sourceMessage[key].path, sourceBytes[key], {
      mode: 0o600,
      flag: 'wx',
    });
  await json(join(tasks, taskId + '.json'), {
    id: taskId,
    displayId: '17',
    subject: 'TEST imported legacy Task with original comment and attachment',
    sourceMessageId: messageId,
    sourceMessage: {
      text: 'TEST existing imported source-message context',
      from: 'user',
      timestamp: '2026-10-23T00:00:00.000Z',
      source: 'user_sent',
      attachments: (['image', 'file'] as const).map((key) => {
        const { path, sha256: _sha, ...metadata } = sourceMessage[key];
        return { ...metadata, filePath: path };
      }),
    },
    status: 'pending',
    owner: 'alice',
    description: `Internal [#18](${href(internal)}), external [#99](${href(external)}), missing [#100](${href(missing)})`,
    descriptionTaskRefs: [internal, external, missing],
    prompt: `TEST separate task prompt [#18](${href(internal)})`,
    promptTaskRefs: [internal],
    related: [linkedTaskId],
    blocks: [],
    blockedBy: [],
    comments: [
      {
        id: 'TEST-legacy-comment',
        type: 'regular',
        author: 'user',
        text: 'TEST retained comment with source-qualified links',
        createdAt: '2026-10-23T00:00:00.000Z',
        taskRefs: [external, missing],
      },
    ],
    attachments: [
      {
        id: 'TEST-task-blob',
        filename: 'saved-note.txt',
        mimeType: 'text/plain',
        size: Buffer.byteLength(blob),
        filePath: blobPath,
      },
    ],
    historyEvents: [],
  });
  await json(join(tasks, linkedTaskId + '.json'), {
    id: linkedTaskId,
    displayId: '18',
    subject: 'TEST imported internal referenced Task',
    status: 'completed',
    related: [taskId],
    blocks: [],
    blockedBy: [],
    comments: [],
    attachments: [],
    historyEvents: [],
  });
  if (options.priorRun) {
    assert.ok(options.node, 'explicit captured TEST Node for source preparation');
    const loader = createRequire(import.meta.url).resolve('tsx');
    execFileSync(
      options.node,
      ['--import', loader, join(import.meta.dirname, 'desktop-stopped-import-prior-run.ts'), root],
      {
        cwd: join(import.meta.dirname, '../..'),
        timeout: 20_000,
        maxBuffer: 128 * 1024,
        env: {
          HOME: join(root, 'home'),
          CLAUDE_ROOT: join(root, 'claude'),
          AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: join(root, 'claude'),
          PATH: '/usr/bin:/bin',
          TMPDIR: join(root, 'tmp'),
        },
      }
    );
  }
  const roots = [team, tasks, attachments, taskAttachments];
  const seed: StoppedImportUiSeed = {
    teamName: LEGACY_IMPORT_TEAM,
    displayName: options.priorRun ? 'TEST captured-stopped solo legacy Team' : LEGACY_IMPORT_LABEL,
    sourceCardLabel: options.priorRun ? LEGACY_IMPORT_TEAM : LEGACY_IMPORT_LABEL,
    ...(options.priorRun
      ? {
          sourceKind: 'captured-stopped-solo' as const,
          priorRun: {
            path: join(root, 'stopped-import-prior-run.json'),
            sha256: digest(await readFile(join(root, 'stopped-import-prior-run.json'))),
          },
        }
      : {}),
    taskId,
    linkedTaskId,
    externalTaskId: external.taskId,
    missingTaskId: missing.taskId,
    blobPath,
    sourceMessage,
    savedSettings,
    roots,
    before: await stoppedImportSourceBytes(root, roots),
  };
  await json(join(root, 'stopped-import-ui-seed.json'), seed);
}

export async function readDesktopStoppedImportSeed(root: string): Promise<StoppedImportUiSeed> {
  const seed = JSON.parse(
    await readFile(join(root, 'stopped-import-ui-seed.json'), 'utf8')
  ) as StoppedImportUiSeed;
  assert.equal(seed.teamName, LEGACY_IMPORT_TEAM);
  assert.equal(
    seed.sourceCardLabel,
    seed.sourceKind === 'captured-stopped-solo' ? LEGACY_IMPORT_TEAM : seed.displayName
  );
  assert.equal(seed.savedSettings.cwd, join(root, 'workspace'));
  assert.deepEqual(seed.roots, [
    join(root, 'claude/teams', LEGACY_IMPORT_TEAM),
    join(root, 'claude/tasks', LEGACY_IMPORT_TEAM),
    join(root, 'userData/data/attachments', LEGACY_IMPORT_TEAM),
    join(root, 'userData/data/task-attachments', LEGACY_IMPORT_TEAM),
  ]);
  return seed;
}
