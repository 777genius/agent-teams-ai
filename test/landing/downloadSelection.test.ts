// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { selectDetectedDownloadAssetId } from '../../landing/utils/downloadSelection.mjs';

describe('landing detected download selection', () => {
  it('selects the unified Windows card for detected Windows systems', () => {
    expect(selectDetectedDownloadAssetId('windows')).toBe('windows');
  });

  it('keeps the unified Windows card when architecture detection is unavailable', () => {
    expect(selectDetectedDownloadAssetId('windows')).toBe('windows');
  });

  it('keeps the existing platform defaults and ignores unknown operating systems', () => {
    expect(selectDetectedDownloadAssetId('macos')).toBe('macos');
    expect(selectDetectedDownloadAssetId('linux')).toBe('linux-appimage');
    expect(selectDetectedDownloadAssetId('unknown')).toBe('');
  });
});
