import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createHash } from 'crypto';
import { structuredPatch } from 'diff';

import type { SnippetDiff } from '@shared/types';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const readFile = vi.fn();
  const writeFile = vi.fn();
  const unlink = vi.fn();
  const mkdir = vi.fn();
  return {
    ...actual,
    mkdir,
    readFile,
    writeFile,
    unlink,
    // ESM interop: some code paths expect a default export
    default: { ...actual, mkdir, readFile, writeFile, unlink },
  };
});

describe('ReviewApplierService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('previewReject avoids write-update snippet-level replacement', async () => {
    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const original = 'hello\nworld\n';
    const modified = 'HELLO\nworld\n';

    // Sanity: ensure there is at least one hunk for this change
    const patch = structuredPatch('file', 'file', original, modified);
    expect(patch.hunks.length).toBeGreaterThan(0);

    const snippets: SnippetDiff[] = [
      {
        toolUseId: 't1',
        filePath: '/tmp/file.txt',
        toolName: 'Write',
        type: 'write-update',
        oldString: '',
        newString: modified, // full file write
        replaceAll: false,
        timestamp: new Date().toISOString(),
        isError: false,
      },
    ];

    const svc = new ReviewApplierService();

    // Preview should restore original content (and must not collapse to empty due to write-update).
    const preview = await svc.previewReject('/tmp/file.txt', original, modified, [0], snippets);
    expect(preview.hasConflicts).toBe(false);
    expect(preview.preview).toBe(original);
  });

  it('deletes a newly created file when fully rejected', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;

    readFile.mockResolvedValue('content\n');
    unlink.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();

    const filePath = '/tmp/new-file.txt';
    const snippets: SnippetDiff[] = [
      {
        toolUseId: 't1',
        filePath,
        toolName: 'Write',
        type: 'write-new',
        oldString: '',
        newString: 'content\n',
        replaceAll: false,
        timestamp: new Date().toISOString(),
        isError: false,
      },
    ];

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          {
            filePath,
            fileDecision: 'rejected',
            hunkDecisions: { 0: 'rejected' },
          },
        ],
      },
      new Map([
        [
          filePath,
          {
            filePath,
            relativePath: 'new-file.txt',
            snippets,
            linesAdded: 1,
            linesRemoved: 0,
            isNewFile: true,
            originalFullContent: '',
            modifiedFullContent: 'content\n',
            contentSource: 'snippet-reconstruction',
          },
        ],
      ])
    );

    expect(res.applied).toBe(1);
    expect(unlink).toHaveBeenCalledWith(filePath);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('ledger create reject deletes only when current hash matches', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;

    const content = 'created\n';
    readFile.mockResolvedValue(content);
    unlink.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const filePath = '/tmp/ledger-created.txt';

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          {
            filePath,
            fileDecision: 'rejected',
            hunkDecisions: { 0: 'rejected' },
          },
        ],
      },
      new Map([
        [
          filePath,
          {
            filePath,
            relativePath: 'ledger-created.txt',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: '',
                newString: content,
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-1',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: null,
                  modifiedFullContent: content,
                  beforeHash: null,
                  afterHash: sha(content),
                  operation: 'create',
                  beforeState: { exists: false },
                  afterState: { exists: true, sha256: sha(content), sizeBytes: content.length },
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 0,
            isNewFile: true,
            originalFullContent: '',
            modifiedFullContent: content,
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(res).toMatchObject({ applied: 1, conflicts: 0 });
    expect(unlink).toHaveBeenCalledWith(filePath);
  });

  it('ledger create reject blocks when current hash changed', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;

    readFile.mockResolvedValue('user changed\n');

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const filePath = '/tmp/ledger-conflict.txt';
    const ledgerContent = 'created\n';

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [{ filePath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } }],
      },
      new Map([
        [
          filePath,
          {
            filePath,
            relativePath: 'ledger-conflict.txt',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: '',
                newString: ledgerContent,
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-1',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: null,
                  modifiedFullContent: ledgerContent,
                  beforeHash: null,
                  afterHash: sha(ledgerContent),
                  operation: 'create',
                  beforeState: { exists: false },
                  afterState: { exists: true, sha256: sha(ledgerContent) },
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 0,
            isNewFile: true,
            originalFullContent: '',
            modifiedFullContent: ledgerContent,
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(res.applied).toBe(0);
    expect(res.conflicts).toBe(1);
    expect(res.errors[0]?.code).toBe('conflict');
    expect(unlink).not.toHaveBeenCalled();
  });

  it('ledger delete reject restores only when file is missing', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;

    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    writeFile.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const filePath = '/tmp/deleted.txt';
    const original = 'restore me\n';

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [{ filePath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } }],
      },
      new Map([
        [
          filePath,
          {
            filePath,
            relativePath: 'deleted.txt',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: original,
                newString: '',
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-1',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: original,
                  modifiedFullContent: null,
                  beforeHash: sha(original),
                  afterHash: null,
                  operation: 'delete',
                  beforeState: { exists: true, sha256: sha(original) },
                  afterState: { exists: false },
                },
              },
            ],
            linesAdded: 0,
            linesRemoved: 1,
            isNewFile: false,
            originalFullContent: original,
            modifiedFullContent: '',
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(res.applied).toBe(1);
    expect(writeFile).toHaveBeenCalledWith(filePath, original, 'utf8');
  });

  it('ledger binary or large unavailable content requires manual review', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;

    readFile.mockResolvedValue('binary placeholder');

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const filePath = '/tmp/blob.bin';

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [{ filePath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } }],
      },
      new Map([
        [
          filePath,
          {
            filePath,
            relativePath: 'blob.bin',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: '',
                newString: '',
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-1',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: null,
                  modifiedFullContent: null,
                  beforeHash: null,
                  afterHash: null,
                  operation: 'modify',
                  beforeState: { exists: true, unavailableReason: 'binary file' },
                  afterState: { exists: true, unavailableReason: 'binary file' },
                },
              },
            ],
            linesAdded: 0,
            linesRemoved: 0,
            isNewFile: false,
            originalFullContent: null,
            modifiedFullContent: null,
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(res.applied).toBe(0);
    expect(res.errors[0]?.code).toBe('manual-review-required');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('ledger rename reject restores old path and deletes new path with hash guards', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;
    const mkdir = fsPromises.mkdir as unknown as ReturnType<typeof vi.fn>;

    const oldPath = '/repo/src/old.ts';
    const newPath = '/repo/src/new.ts';
    const oldContent = 'old\n';
    const newContent = 'new\n';
    readFile.mockImplementation(async (filePath: string) => {
      if (filePath === newPath) return newContent;
      if (filePath === oldPath) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      throw new Error(`unexpected read ${filePath}`);
    });
    mkdir.mockResolvedValue(undefined);
    writeFile.mockResolvedValue(undefined);
    unlink.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const relation = { kind: 'rename' as const, oldPath: 'src/old.ts', newPath: 'src/new.ts' };

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          { filePath: newPath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } },
        ],
      },
      new Map([
        [
          newPath,
          {
            filePath: newPath,
            relativePath: 'src/new.ts',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath: oldPath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: oldContent,
                newString: '',
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-old',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: oldContent,
                  modifiedFullContent: null,
                  beforeHash: sha(oldContent),
                  afterHash: null,
                  operation: 'delete',
                  beforeState: { exists: true, sha256: sha(oldContent) },
                  afterState: { exists: false },
                  relation,
                },
              },
              {
                toolUseId: 'ledger-1',
                filePath: newPath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: '',
                newString: newContent,
                replaceAll: false,
                timestamp: '2026-03-01T10:00:01.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-new',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: null,
                  modifiedFullContent: newContent,
                  beforeHash: null,
                  afterHash: sha(newContent),
                  operation: 'create',
                  beforeState: { exists: false },
                  afterState: { exists: true, sha256: sha(newContent) },
                  relation,
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 1,
            isNewFile: false,
            originalFullContent: oldContent,
            modifiedFullContent: newContent,
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(res).toMatchObject({ applied: 1, conflicts: 0 });
    expect(mkdir).toHaveBeenCalledWith('/repo/src', { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(oldPath, oldContent, 'utf8');
    expect(unlink).toHaveBeenCalledWith(newPath);
  });

  it('ledger rename reject blocks when new path hash changed', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;
    const unlink = fsPromises.unlink as unknown as ReturnType<typeof vi.fn>;

    const oldPath = '/repo/src/old.ts';
    const newPath = '/repo/src/new.ts';
    const oldContent = 'old\n';
    const newContent = 'new\n';
    readFile.mockResolvedValue('user changed\n');

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();
    const relation = { kind: 'rename' as const, oldPath: 'src/old.ts', newPath: 'src/new.ts' };

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          { filePath: newPath, fileDecision: 'rejected', hunkDecisions: { 0: 'rejected' } },
        ],
      },
      new Map([
        [
          newPath,
          {
            filePath: newPath,
            relativePath: 'src/new.ts',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath: oldPath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: oldContent,
                newString: '',
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-old',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: oldContent,
                  modifiedFullContent: null,
                  beforeHash: sha(oldContent),
                  afterHash: null,
                  operation: 'delete',
                  beforeState: { exists: true, sha256: sha(oldContent) },
                  afterState: { exists: false },
                  relation,
                },
              },
              {
                toolUseId: 'ledger-1',
                filePath: newPath,
                toolName: 'Bash',
                type: 'shell-snapshot',
                oldString: '',
                newString: newContent,
                replaceAll: false,
                timestamp: '2026-03-01T10:00:01.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-new',
                  source: 'ledger-snapshot',
                  confidence: 'high',
                  originalFullContent: null,
                  modifiedFullContent: newContent,
                  beforeHash: null,
                  afterHash: sha(newContent),
                  operation: 'create',
                  beforeState: { exists: false },
                  afterState: { exists: true, sha256: sha(newContent) },
                  relation,
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 1,
            isNewFile: false,
            originalFullContent: oldContent,
            modifiedFullContent: newContent,
            contentSource: 'ledger-snapshot',
          },
        ],
      ])
    );

    expect(res.applied).toBe(0);
    expect(res.conflicts).toBe(1);
    expect(res.errors[0]?.code).toBe('conflict');
    expect(writeFile).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('ledger exact partial reject stays in the strict ledger lane and applies inverse hunk patch', async () => {
    const fsPromises = await import('fs/promises');
    const readFile = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const writeFile = fsPromises.writeFile as unknown as ReturnType<typeof vi.fn>;

    const filePath = '/tmp/exact-ledger.ts';
    const original = 'const value = 1;\nconst keep = true;\n';
    const modified = 'const value = 2;\nconst keep = true;\n';
    readFile.mockResolvedValue(modified);
    writeFile.mockResolvedValue(undefined);

    const { ReviewApplierService } = await import('@main/services/team/ReviewApplierService');
    const svc = new ReviewApplierService();

    const res = await svc.applyReviewDecisions(
      {
        teamName: 'team',
        decisions: [
          {
            filePath,
            fileDecision: 'pending',
            hunkDecisions: { 0: 'rejected' },
          },
        ],
      },
      new Map([
        [
          filePath,
          {
            filePath,
            relativePath: 'exact-ledger.ts',
            snippets: [
              {
                toolUseId: 'ledger-1',
                filePath,
                toolName: 'Edit',
                type: 'edit',
                oldString: 'const value = 1;\n',
                newString: 'const value = 2;\n',
                replaceAll: false,
                timestamp: '2026-03-01T10:00:00.000Z',
                isError: false,
                ledger: {
                  eventId: 'event-1',
                  source: 'ledger-exact',
                  confidence: 'exact',
                  originalFullContent: original,
                  modifiedFullContent: modified,
                  beforeHash: sha(original),
                  afterHash: sha(modified),
                  operation: 'modify',
                  beforeState: { exists: true, sha256: sha(original) },
                  afterState: { exists: true, sha256: sha(modified) },
                },
              },
            ],
            linesAdded: 1,
            linesRemoved: 1,
            isNewFile: false,
            originalFullContent: original,
            modifiedFullContent: modified,
            contentSource: 'ledger-exact',
          },
        ],
      ])
    );

    expect(res).toMatchObject({ applied: 1, conflicts: 0 });
    expect(writeFile).toHaveBeenCalledWith(filePath, original, 'utf8');
  });
});

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
