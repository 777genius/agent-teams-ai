import { describe, expect, it, vi } from 'vitest';

import { createEditorTabsRepository } from '../../../src/features/editor-tab-sessions/core/application/editorTabsRepository';
import { decodeEditorTabSessions, editorSessionPathKey, normalizeEditorTabSession } from '../../../src/features/editor-tab-sessions/core/domain/tabSession';
import { createLocalEditorTabsStorage } from '../../../src/features/editor-tab-sessions/renderer/adapters/localEditorTabsStorage';

describe('project editor tab metadata', () => {
  it('normalizes identity without folding POSIX case or losing filesystem roots', () => {
    expect(editorSessionPathKey('/Work/./project/')).toBe('/Work/project');
    expect(editorSessionPathKey('/work/project')).not.toBe(editorSessionPathKey('/Work/project'));
    expect(editorSessionPathKey('C:\\Work\\Project\\')).toBe('c:/work/project');
    expect(editorSessionPathKey('C:\\')).toBe('c:/');
    expect(editorSessionPathKey('/')).toBe('/');
    expect(editorSessionPathKey('\\\\HOST\\Share\\project')).toBe('//host/share/project');
  });

  it('rejects malformed/outside paths and deduplicates while preserving display spelling', () => {
    const session = normalizeEditorTabSession('C:/Work', { paths: ['C:\\Work\\A.txt', 'c:/work/a.txt', 'c:/work/b.txt', 'c:/work/../secret.txt', 'c:/worker/file.txt', 'file:///c:/work/x', 42], active: 'C:\\WORK\\B.txt' });
    expect(session).toEqual({ paths: ['C:\\Work\\A.txt', 'c:/work/b.txt'], active: 'c:/work/b.txt' });
    expect(normalizeEditorTabSession('/', { paths: ['/a.txt'], active: '/missing.txt' }).active).toBe('/a.txt');
    expect(decodeEditorTabSessions('{broken')).toEqual([]);
    expect(decodeEditorTabSessions('{"version":99,"projects":[]}')).toEqual([]);
  });

  it('restores independent ordered projects across fresh repository instances', () => {
    let disk: string | null = null;
    const storage = { read: () => disk, write: (value: string) => { disk = value; } };
    const repository = createEditorTabsRepository(storage);
    repository.save('/a', { paths: ['/a/second.txt', '/a/first.txt'], active: '/a/first.txt' });
    repository.save('/b', { paths: ['/b/file.txt'], active: '/b/file.txt' });
    const restarted = createEditorTabsRepository(storage);
    expect(restarted.load('/a/')).toEqual({ paths: ['/a/second.txt', '/a/first.txt'], active: '/a/first.txt' });
    expect(restarted.load('/b').paths).toEqual(['/b/file.txt']);
    restarted.save('/a', { paths: [], active: null });
    expect(repository.load('/a').paths).toEqual([]);
    expect(repository.load('/b').paths).toEqual(['/b/file.txt']);
  });

  it('keeps the latest session in memory after a failed write instead of resurrecting stale disk', () => {
    let disk: string | null = null;
    let failing = false;
    const storage = createLocalEditorTabsStorage(() => ({
      getItem: () => disk,
      setItem: (_key, value) => { if (failing) throw new Error('quota'); disk = value; },
    }));
    const repository = createEditorTabsRepository(storage);
    repository.save('/a', { paths: ['/a/old.txt'], active: '/a/old.txt' });
    failing = true;
    repository.save('/a', { paths: ['/a/new.txt'], active: '/a/new.txt' });
    expect(repository.load('/a').paths).toEqual(['/a/new.txt']);
    expect(disk).toContain('old.txt');
    repository.save('/a', { paths: ['/a/latest.txt'], active: '/a/latest.txt' });
    expect(repository.load('/a').paths).toEqual(['/a/latest.txt']);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      '[EditorTabSessions:storage]',
      'Persistent editor tab storage unavailable; using session memory'
    );
    vi.mocked(console.warn).mockClear();
  });

  it('bounds metadata without persisting document contents', () => {
    const disk: { raw: string | null } = { raw: null };
    const repository = createEditorTabsRepository({ read: () => disk.raw, write: value => { disk.raw = value; } });
    for (let index = 0; index < 40; index++) repository.save('/p' + index, { paths: Array.from({ length: 100 }, (_, file) => `/p${index}/${file}.txt`), active: null });
    const projects = decodeEditorTabSessions(disk.raw);
    expect(projects).toHaveLength(32);
    expect(projects[0].paths).toHaveLength(64);
    expect(repository.load('/p0').paths).toEqual([]);
    expect(disk.raw?.length).toBeLessThanOrEqual(512 * 1024);
  });
});
