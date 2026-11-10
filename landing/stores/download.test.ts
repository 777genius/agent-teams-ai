import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDownloadStore } from './download';

const platformMocks = vi.hoisted(() => ({
  detectArchFromNavigator: vi.fn(),
  detectMacArchFromNavigator: vi.fn(),
  detectPlatform: vi.fn(),
}));

vi.mock('~/utils/platform', () => platformMocks);

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('landing download store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.resetAllMocks();
    platformMocks.detectPlatform.mockReturnValue('windows');
  });

  it.each(['windows', 'linux-appimage'])(
    'preserves a manual %s selection while Windows architecture detection is pending',
    async (selectedId) => {
      const detection = deferred<'arm64'>();
      platformMocks.detectArchFromNavigator.mockReturnValue(detection.promise);
      const store = useDownloadStore();

      const initialization = store.init();
      expect(platformMocks.detectPlatform).toHaveBeenCalledOnce();
      store.setSelected(selectedId);
      detection.resolve('arm64');
      await initialization;

      expect(store.selectedId).toBe(selectedId);
      expect(store.selectionSource).toBe('manual');
    },
  );

  it('preserves a manual macOS architecture while Windows detection is pending', async () => {
    const detection = deferred<'arm64'>();
    platformMocks.detectArchFromNavigator.mockReturnValue(detection.promise);
    const store = useDownloadStore();

    const initialization = store.init();
    expect(platformMocks.detectPlatform).toHaveBeenCalledOnce();
    store.setMacArch('x64');
    detection.resolve('arm64');
    await initialization;

    expect(store.os).toBe('macos');
    expect(store.arch).toBe('x64');
    expect(store.selectedId).toBe('macos');
  });

  it('selects the unified Windows card and preserves a manual Windows architecture', () => {
    const store = useDownloadStore();

    store.setWindowsArch('arm64');

    expect(store.os).toBe('windows');
    expect(store.arch).toBe('arm64');
    expect(store.windowsArch).toBe('arm64');
    expect(store.selectedId).toBe('windows');
  });

  it('defaults Windows to x64 without claiming the architecture was detected', () => {
    const store = useDownloadStore();

    store.setSelected('windows');

    expect(store.arch).toBe('unknown');
    expect(store.windowsArch).toBe('x64');
    expect(store.selectedId).toBe('windows');
  });

  it('preserves a manual Windows architecture while macOS detection is pending', async () => {
    platformMocks.detectPlatform.mockReturnValue('macos');
    const detection = deferred<'x64'>();
    platformMocks.detectMacArchFromNavigator.mockReturnValue(detection.promise);
    const store = useDownloadStore();

    const initialization = store.init();
    expect(platformMocks.detectPlatform).toHaveBeenCalledOnce();
    store.setWindowsArch('arm64');
    detection.resolve('x64');
    await initialization;

    expect(store.os).toBe('windows');
    expect(store.windowsArch).toBe('arm64');
    expect(store.selectedId).toBe('windows');
  });

  it('defaults macOS to Apple Silicon without claiming the architecture was detected', () => {
    const store = useDownloadStore();

    store.setSelected('macos');

    expect(store.arch).toBe('unknown');
    expect(store.macArch).toBe('arm64');
    expect(store.selectedId).toBe('macos');
  });

  it.each([
    ['windows', 'x64'],
    ['macos', 'arm64'],
  ] as const)(
    'uses the %s default when architecture detection is unknown',
    async (os, defaultArch) => {
      platformMocks.detectPlatform.mockReturnValue(os);
      platformMocks.detectArchFromNavigator.mockResolvedValue('unknown');
      platformMocks.detectMacArchFromNavigator.mockResolvedValue('unknown');
      const store = useDownloadStore();

      await store.init();

      expect(store.arch).toBe('unknown');
      expect(store.selectedId).toBe(os);
      expect(os === 'windows' ? store.windowsArch : store.macArch).toBe(defaultArch);
      expect(store.archSource).toBe('auto');
    },
  );

  it.each([
    ['windows', 'arm64'],
    ['windows', 'x64'],
    ['macos', 'arm64'],
    ['macos', 'x64'],
  ] as const)(
    'preserves detected %s %s instead of replacing it with the default',
    async (os, arch) => {
      platformMocks.detectPlatform.mockReturnValue(os);
      platformMocks.detectArchFromNavigator.mockResolvedValue(arch);
      platformMocks.detectMacArchFromNavigator.mockResolvedValue(arch);
      const store = useDownloadStore();

      await store.init();

      expect(store.arch).toBe(arch);
      expect(os === 'windows' ? store.windowsArch : store.macArch).toBe(arch);
    },
  );

  it.each([
    ['macos', 'x64', 'windows', 'x64'],
    ['windows', 'arm64', 'macos', 'arm64'],
  ] as const)(
    'resolves the architecture when switching from %s %s to %s with the %s default',
    async (os, arch, selectedId, defaultArch) => {
      platformMocks.detectPlatform.mockReturnValue(os);
      platformMocks.detectArchFromNavigator.mockResolvedValue(arch);
      platformMocks.detectMacArchFromNavigator.mockResolvedValue(arch);
      const store = useDownloadStore();
      await store.init();

      store.setSelected(selectedId);

      expect(store.selectedId).toBe(selectedId);
      expect(selectedId === 'windows' ? store.windowsArch : store.macArch).toBe(defaultArch);
      expect(store.os).toBe(os);
      expect(store.arch).toBe(arch);
    },
  );

  it('retains independent manual architectures when switching platform cards', () => {
    const store = useDownloadStore();
    store.setMacArch('x64');
    store.setWindowsArch('arm64');

    store.setSelected('macos');
    expect(store.macArch).toBe('x64');

    store.setSelected('windows');
    expect(store.windowsArch).toBe('arm64');
  });

  it.each(['windows', 'macos'] as const)(
    'preserves a manual %s architecture during detection',
    async (os) => {
      platformMocks.detectPlatform.mockReturnValue(os);
      const detection = deferred<'arm64' | 'x64'>();
      platformMocks.detectArchFromNavigator.mockReturnValue(detection.promise);
      platformMocks.detectMacArchFromNavigator.mockReturnValue(detection.promise);
      const store = useDownloadStore();

      const initialization = store.init();
      expect(platformMocks.detectPlatform).toHaveBeenCalledOnce();
      if (os === 'windows') store.setWindowsArch('arm64');
      else store.setMacArch('x64');
      detection.resolve(os === 'windows' ? 'x64' : 'arm64');
      await initialization;

      expect(store.selectedId).toBe(os);
      expect(store.arch).toBe(os === 'windows' ? 'arm64' : 'x64');
      expect(os === 'windows' ? store.windowsArch : store.macArch).toBe(store.arch);
      expect(store.archSource).toBe('manual');
    },
  );
});
