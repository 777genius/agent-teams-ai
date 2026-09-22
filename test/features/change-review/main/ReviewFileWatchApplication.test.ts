import {
  ReviewFileWatchApplication,
  type ReviewFileWatcherPort,
} from '@features/change-review/main';
import { describe, expect, it, vi } from 'vitest';

import type { EditorFileChangeEvent } from '@shared/types/editor';

function createWatcher(events: string[], name = 'watcher') {
  let watching = false;
  let emitChange: ((event: EditorFileChangeEvent) => void) | null = null;
  const watcher = {
    isWatching: vi.fn(() => watching),
    setWatchedFiles: vi.fn((filePaths: string[]) => {
      events.push(`${name}:files:${filePaths.join(',')}`);
    }),
    start: vi.fn((projectRoot: string, onChange: (event: EditorFileChangeEvent) => void) => {
      events.push(`${name}:start:${projectRoot}`);
      watching = true;
      emitChange = onChange;
    }),
    stop: vi.fn(() => {
      events.push(`${name}:stop`);
      watching = false;
    }),
  } satisfies ReviewFileWatcherPort;

  return {
    watcher,
    emit(event: EditorFileChangeEvent): void {
      if (!emitChange) throw new Error('watcher was not started');
      emitChange(event);
    },
  };
}

describe('ReviewFileWatchApplication', () => {
  it('restarts only when required, preserves watched inputs, and forwards events', async () => {
    const events: string[] = [];
    const defaultWatcher = createWatcher(events);
    const present = vi.fn();
    const validate = vi.fn(() => Promise.resolve('/normalized/project'));
    const application = new ReviewFileWatchApplication({
      defaultWatcher: defaultWatcher.watcher,
      defaultProjectPathValidator: validate,
      events: { present },
    });

    const firstOperation = application.prepareWatch('/raw/project', ['/normalized/project/a.ts']);
    expect(validate).not.toHaveBeenCalled();
    await firstOperation();

    expect(events).toEqual([
      'watcher:stop',
      'watcher:start:/normalized/project',
      'watcher:files:/normalized/project/a.ts',
    ]);
    const change = { type: 'change', path: '/normalized/project/a.ts' } as const;
    defaultWatcher.emit(change);
    expect(present).toHaveBeenCalledWith(change);

    await application.prepareWatch('/same/project', false)();

    expect(defaultWatcher.watcher.start).toHaveBeenCalledTimes(1);
    expect(defaultWatcher.watcher.stop).toHaveBeenCalledTimes(1);
    expect(defaultWatcher.watcher.setWatchedFiles).toHaveBeenLastCalledWith([]);
  });

  it('ignores a late validation after unwatch and a newer subscription', async () => {
    const events: string[] = [];
    const defaultWatcher = createWatcher(events);
    let resolveOldProject!: (projectPath: string) => void;
    const oldValidation = new Promise<string>((resolve) => {
      resolveOldProject = resolve;
    });
    const validate = vi.fn((projectPath: string) =>
      projectPath === '/old' ? oldValidation : Promise.resolve('/new')
    );
    const application = new ReviewFileWatchApplication({
      defaultWatcher: defaultWatcher.watcher,
      defaultProjectPathValidator: validate,
      events: { present: vi.fn() },
    });

    const lateOldWatch = application.prepareWatch('/old', ['/old/a.ts'])();
    await vi.waitFor(() => expect(validate).toHaveBeenCalledWith('/old'));
    await application.prepareUnwatch()();
    await application.prepareWatch('/new', ['/new/b.ts'])();
    resolveOldProject('/old');
    await lateOldWatch;

    expect(defaultWatcher.watcher.start).toHaveBeenCalledTimes(1);
    expect(defaultWatcher.watcher.start).toHaveBeenCalledWith('/new', expect.any(Function));
    expect(defaultWatcher.watcher.setWatchedFiles).toHaveBeenCalledTimes(1);
    expect(defaultWatcher.watcher.setWatchedFiles).toHaveBeenCalledWith(['/new/b.ts']);
  });

  it('supersedes pending work on reconfigure and owns replacement and cleanup order', async () => {
    const events: string[] = [];
    const defaultWatcher = createWatcher(events, 'default');
    const replacementWatcher = createWatcher(events, 'replacement');
    let resolvePending!: (projectPath: string) => void;
    const pendingValidation = new Promise<string>((resolve) => {
      resolvePending = resolve;
    });
    const application = new ReviewFileWatchApplication({
      defaultWatcher: defaultWatcher.watcher,
      defaultProjectPathValidator: () => pendingValidation,
      events: { present: vi.fn() },
    });

    const pendingWatch = application.prepareWatch('/pending', ['/pending/a.ts'])();
    application.supersedePendingRequests();
    application.configure({
      fileWatcher: replacementWatcher.watcher,
      projectPathValidator: () => Promise.resolve('/replacement'),
    });
    resolvePending('/pending');
    await pendingWatch;
    await application.prepareWatch('/replacement', ['/replacement/b.ts'])();
    application.dispose();

    expect(events).toEqual([
      'default:stop',
      'replacement:stop',
      'replacement:start:/replacement',
      'replacement:files:/replacement/b.ts',
      'replacement:stop',
    ]);
    expect(defaultWatcher.watcher.setWatchedFiles).not.toHaveBeenCalled();
  });
});
