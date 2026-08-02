// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { selectDetectedDownloadAssetId } from '../../landing/utils/downloadSelection';

describe('landing detected download selection', () => {
  it('selects the native Windows installer from the detected architecture', () => {
    expect(selectDetectedDownloadAssetId('windows', 'arm64')).toBe('windows-arm64');
    expect(selectDetectedDownloadAssetId('windows', 'x64')).toBe('windows-x64');
  });

  it('uses Windows x64 only as the unknown-architecture fallback', () => {
    expect(selectDetectedDownloadAssetId('windows', 'unknown')).toBe('windows-x64');
  });

  it('keeps the existing platform defaults and ignores unknown operating systems', () => {
    expect(selectDetectedDownloadAssetId('macos', 'arm64')).toBe('macos');
    expect(selectDetectedDownloadAssetId('linux', 'x64')).toBe('linux-appimage');
    expect(selectDetectedDownloadAssetId('unknown', 'unknown')).toBe('');
  });
});
