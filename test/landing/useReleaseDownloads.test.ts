// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  parseWindowsReleaseVariants,
  resolveWindowsReleaseDownload,
} from '../../landing/utils/windowsReleaseDownloads';

describe('landing release downloads', () => {
  it('keeps Windows x64 and ARM64 release assets in separate variants', () => {
    const variants = parseWindowsReleaseVariants(
      [
        {
          name: 'Agent.Teams.AI.Setup.2.12.0-arm64.exe',
          browser_download_url: 'https://example.test/windows-arm64.exe',
        },
        {
          name: 'Agent.Teams.AI.Setup.2.12.0.exe',
          browser_download_url: 'https://example.test/windows-x64.exe',
        },
      ],
      '2.12.0'
    );

    expect(variants.arm64.url).toBe('https://example.test/windows-arm64.exe');
    expect(variants.x64.url).toBe('https://example.test/windows-x64.exe');
    expect(resolveWindowsReleaseDownload(variants, '2.12.0', 'arm64')).toEqual({
      url: 'https://example.test/windows-arm64.exe',
      version: '2.12.0',
    });
    expect(resolveWindowsReleaseDownload(variants, '2.12.0', 'x64')).toEqual({
      url: 'https://example.test/windows-x64.exe',
      version: '2.12.0',
    });
  });

  it('does not expose an x64 installer as the ARM64 variant when ARM64 is unavailable', () => {
    const variants = parseWindowsReleaseVariants(
      [
        {
          name: 'Agent.Teams.AI.Setup.2.12.0.exe',
          browser_download_url: 'https://example.test/windows-x64.exe',
        },
      ],
      '2.12.0'
    );

    expect(variants.arm64.url).toBeNull();
    expect(variants.x64.url).toBe('https://example.test/windows-x64.exe');
    expect(resolveWindowsReleaseDownload(variants, '2.12.0', 'arm64')).toBeNull();
  });
});
