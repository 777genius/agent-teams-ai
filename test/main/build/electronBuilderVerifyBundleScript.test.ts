// @vitest-environment node
import { describe, expect, it } from 'vitest';

const { isAllowedPostPackMismatch } =
  require('../../../scripts/electron-builder/verifyBundle.cjs')._internal;

const elevateMismatch = {
  path: 'resources/elevate.exe',
  format: 'pe',
  archs: ['ia32'],
};

describe('electron-builder bundle verification', () => {
  it('allows the known NSIS elevation helper for supported Windows architectures', () => {
    expect(isAllowedPostPackMismatch(elevateMismatch, 'win32', 'x64')).toBe(true);
    expect(isAllowedPostPackMismatch(elevateMismatch, 'win32', 'arm64')).toBe(true);
  });

  it('keeps the elevation helper exception fail-closed', () => {
    expect(isAllowedPostPackMismatch(elevateMismatch, 'win32', 'ia32')).toBe(false);
    expect(isAllowedPostPackMismatch(elevateMismatch, 'linux', 'arm64')).toBe(false);
    expect(
      isAllowedPostPackMismatch(
        { ...elevateMismatch, path: 'resources/other-helper.exe' },
        'win32',
        'arm64'
      )
    ).toBe(false);
    expect(
      isAllowedPostPackMismatch({ ...elevateMismatch, archs: ['x64'] }, 'win32', 'arm64')
    ).toBe(false);
  });
});
