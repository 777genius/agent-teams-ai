import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, reactive } from 'vue';
import { useDownloadAssetPresentation } from '../composables/useDownloadAssetPresentation';
import { parseReleaseDownloads, platformReleaseInfo, resolveReleaseDownload } from './releaseDownloads';
import type { DownloadArch } from '../data/downloads';

const repository = '777genius/agent-teams-ai';

function presentation(
  channel: string,
  payloads: { arm64: string | null; x64: string | null },
  architecture: DownloadArch | 'unknown'
) {
  const names = (['arm64', 'x64'] as const).map((arch) =>
    payloads[arch] === null
      ? `Agent.Teams.AI-${arch}.dmg`
      : `Agent.Teams.AI-${payloads[arch]}-${arch}.dmg`
  );
  const data = parseReleaseDownloads({
    tag_name: `v${channel}`,
    body: null,
    published_at: '2026-10-07T12:00:00Z',
    assets: names.map((name) => ({
      name,
      browser_download_url: `https://github.com/${repository}/releases/download/v${channel}/${name}`,
    })),
  }, repository);
  const store = reactive({
    macArch: architecture,
    windowsArch: 'x64',
    selectedId: 'macos',
    selectedAsset: {
      id: 'macos', os: 'macos', arch: 'universal', archLabel: 'Apple Silicon / Intel',
      label: 'macOS', fileName: 'Agent.Teams.AI-arm64.dmg',
    },
  });
  vi.stubGlobal('useDownloadStore', () => store);
  vi.stubGlobal('useReleaseDownloads', () => ({
    platformInfo: (os: 'macos', arch: DownloadArch | 'unknown') =>
      arch === 'unknown' || arch === 'universal'
        ? platformReleaseInfo(data, os)
        : resolveReleaseDownload(data, os, arch),
  }));
  vi.stubGlobal('computed', computed);
  return { store, result: useDownloadAssetPresentation() };
}

afterEach(() => vi.unstubAllGlobals());

describe('Mac download requirement presentation', () => {
  it.each(['arm64', 'x64'] as const)('shows macOS 13 for the actual 2.17.7 %s payload', (arch) => {
    const { result } = presentation('2.17.7', { arm64: '2.17.7', x64: '2.17.7' }, arch);
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe(
      `macOS 13+ · ${arch === 'arm64' ? 'Apple Silicon' : 'Intel'}`
    );
  });

  it.each(['arm64', 'x64'] as const)('keeps macOS 12 for carried 2.17.1 %s in channel 2.17.6', (arch) => {
    const { result } = presentation('2.17.6', { arm64: '2.17.1', x64: '2.17.1' }, arch);
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe(
      `macOS 12+ · ${arch === 'arm64' ? 'Apple Silicon' : 'Intel'}`
    );
  });

  it('updates the requirement when the selected architecture changes', () => {
    const { result, store } = presentation('2.17.7', { arm64: '2.17.1', x64: '2.17.7' }, 'arm64');
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe('macOS 12+ · Apple Silicon');
    store.macArch = 'x64';
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe('macOS 13+ · Intel');
  });

  it.each([
    { arm64: null, x64: null },
    { arm64: '2.17.1', x64: '2.17.7' },
    { arm64: '9.0.0', x64: '9.0.0' },
  ])('omits an unproved floor before architecture selection: %j', (payloads) => {
    const { result } = presentation('2.17.7', payloads, 'unknown');
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe('macOS · Apple Silicon & Intel');
  });

  it('omits a floor for an alias-only selected payload', () => {
    const { result } = presentation('2.17.7', { arm64: null, x64: null }, 'x64');
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe('macOS · Intel');
  });
});
