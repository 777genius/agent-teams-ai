import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, reactive, ref } from 'vue';
import { useDownloadAssetPresentation } from '../composables/useDownloadAssetPresentation';
import { parseReleaseDownloads, platformReleaseInfo, resolveReleaseDownload } from './releaseDownloads';
import type { DownloadArch, DownloadOs } from '../data/downloads';

const repository = '777genius/agent-teams-ai';

function presentation(
  channel: string,
  payloads: { arm64: string | null; x64: string | null },
  architecture: DownloadArch | 'unknown',
  macProductMinimum: unknown = '13.0',
  manifestValue?: unknown
) {
  const names = (['arm64', 'x64'] as const).flatMap((arch) =>
    payloads[arch] === null
      ? [`Agent.Teams.AI-${arch}.dmg`]
      : [`Agent.Teams.AI-${payloads[arch]}-${arch}.dmg`, `Agent.Teams.AI-${payloads[arch]}-${arch}-mac.zip`]
  );
  names.push(`Agent.Teams.AI.Setup.${channel}.exe`, `Agent.Teams.AI.Setup.${channel}-arm64.exe`,
    `Agent.Teams.AI-${channel}.AppImage`, `agent-teams-ai_${channel}_amd64.deb`,
    `agent-teams-ai-${channel}.x86_64.rpm`, `agent-teams-ai-${channel}.pacman`);
  const manifest = {
    schemaVersion: 1,
    phase: 'assembled',
    input: {
      repository, target: { tag: `v${channel}` },
      mode: payloads.arm64 === channel ? 'full' : 'carry-mac', macProductMinimum,
      macSource: { productMinimum: macProductMinimum, release: { tag: `v${payloads.arm64}`, createdAt: '2026-10-06T12:00:00Z' } },
    },
    versions: { windows: channel, linux: channel, mac: payloads.arm64 },
  };
  const data = ref(parseReleaseDownloads({
    tag_name: `v${channel}`,
    body: null,
    published_at: '2026-10-07T12:00:00Z',
    assets: names.map((name) => ({
      name,
      browser_download_url: `https://github.com/${repository}/releases/download/v${channel}/${name}`,
    })),
  }, repository, manifestValue === undefined ? manifest : manifestValue));
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
  const platformInfo = (os: DownloadOs, arch: DownloadArch | 'unknown') =>
    arch === 'unknown' || arch === 'universal'
      ? platformReleaseInfo(data.value, os)
      : (resolveReleaseDownload(data.value, os, arch) ?? { version: null, pubDate: null });
  const registerReleaseData = vi.fn(() => ({ platformInfo }));
  vi.stubGlobal('useReleaseDownloads', registerReleaseData);
  vi.stubGlobal('computed', computed);
  return { store, releaseData: data, registerReleaseData, result: useDownloadAssetPresentation(platformInfo) };
}

afterEach(() => vi.unstubAllGlobals());

describe('Mac download requirement presentation', () => {
  it('uses the existing release resolver without registering another async-data consumer', () => {
    const { result, registerReleaseData } = presentation('2.17.7', { arm64: '2.17.7', x64: '2.17.7' }, 'arm64');
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe('macOS 13+ · Apple Silicon');
    expect(registerReleaseData).not.toHaveBeenCalled();
  });

  it('updates the requirement when the existing consumer receives release metadata', () => {
    const pending = presentation('2.17.7', { arm64: null, x64: null }, 'arm64');
    const resolved = presentation('2.17.7', { arm64: '2.17.7', x64: '2.17.7' }, 'arm64');
    expect(pending.result.selectedDownloadAsset.value?.actionSubtitle).toBe('macOS · Apple Silicon');
    pending.releaseData.value = resolved.releaseData.value;
    expect(pending.result.selectedDownloadAsset.value?.actionSubtitle).toBe('macOS 13+ · Apple Silicon');
    expect(pending.registerReleaseData).not.toHaveBeenCalled();
  });

  it.each(['arm64', 'x64'] as const)('shows macOS 13 for the actual 2.17.7 %s payload', (arch) => {
    const { result } = presentation('2.17.7', { arm64: '2.17.7', x64: '2.17.7' }, arch);
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe(
      `macOS 13+ · ${arch === 'arm64' ? 'Apple Silicon' : 'Intel'}`
    );
  });

  it.each(['arm64', 'x64'] as const)('keeps macOS 12 for carried 2.17.1 %s in channel 2.17.6', (arch) => {
    const { result } = presentation('2.17.6', { arm64: '2.17.1', x64: '2.17.1' }, arch, '12.0');
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe(
      `macOS 12+ · ${arch === 'arm64' ? 'Apple Silicon' : 'Intel'}`
    );
  });

  it('keeps the original signed 2.17.1 minimum without a platform manifest', () => {
    const { result } = presentation('2.17.1', { arm64: '2.17.1', x64: '2.17.1' }, 'x64', '12.0', null);
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe('macOS 12+ · Intel');
  });

  it('updates the requirement when the selected architecture changes', () => {
    const { result, store } = presentation('2.17.7', { arm64: '2.17.1', x64: '2.17.7' }, 'arm64');
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe('macOS · Apple Silicon');
    store.macArch = 'x64';
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe('macOS · Intel');
  });

  it.each([
    { arm64: null, x64: null },
    { arm64: '2.17.1', x64: '2.17.7' },
  ])('omits an unproved floor before architecture selection: %j', (payloads) => {
    const { result } = presentation('2.17.7', payloads, 'unknown');
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe('macOS · Apple Silicon & Intel');
  });

  it('omits a floor for an alias-only selected payload', () => {
    const { result } = presentation('2.17.7', { arm64: null, x64: null }, 'x64');
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe('macOS · Intel');
  });

  it.each([
    ['arm64', '12.0'], ['arm64', '13.0'], ['x64', '12.0'], ['x64', '13.0'],
  ] as const)('uses the declared minimum for future %s/%s instead of guessing from its version', (arch, minimum) => {
    const { result } = presentation('2.17.8', { arm64: '2.17.8', x64: '2.17.8' }, arch, minimum);
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe(
      `macOS ${minimum.replace('.0', '')}+ · ${arch === 'arm64' ? 'Apple Silicon' : 'Intel'}`
    );
  });

  it.each([null, '9.0.0', '13', 13])('omits an unsupported or absent declared minimum: %j', (minimum) => {
    const { result } = presentation('2.17.7', { arm64: '2.17.7', x64: '2.17.7' }, 'arm64', minimum);
    expect(result.selectedDownloadAsset.value?.actionSubtitle).toBe('macOS · Apple Silicon');
  });
});
