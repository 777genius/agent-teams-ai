import { describe, expect, it } from 'vitest';

import { decodeInstallerProcessOutput } from '../decodeInstallerProcessOutput';

describe('decodeInstallerProcessOutput', () => {
  it('decodes cp866 Windows console output with Cyrillic text', () => {
    const buffer = Buffer.from([0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2, 0x20, 0x8c, 0xa8, 0xe0]);

    expect(decodeInstallerProcessOutput(buffer, 'win32')).toBe('Привет Мир');
  });

  it('keeps utf8 output readable on non-Windows platforms', () => {
    const buffer = Buffer.from('tmux is available\n', 'utf8');

    expect(decodeInstallerProcessOutput(buffer, 'darwin')).toBe('tmux is available\n');
  });

  it('keeps utf8 Cyrillic output readable on non-Windows platforms', () => {
    const buffer = Buffer.from('Привет мир\n', 'utf8');

    expect(decodeInstallerProcessOutput(buffer, 'darwin')).toBe('Привет мир\n');
  });

  it('keeps utf8 output readable on Windows too', () => {
    const buffer = Buffer.from('tmux is available\n', 'utf8');

    expect(decodeInstallerProcessOutput(buffer, 'win32')).toBe('tmux is available\n');
  });

  it('keeps utf8 Cyrillic output readable on Windows too', () => {
    const buffer = Buffer.from('Привет мир\n', 'utf8');

    expect(decodeInstallerProcessOutput(buffer, 'win32')).toBe('Привет мир\n');
  });

  it('decodes utf16le output when it contains a BOM', () => {
    const utf16le = Buffer.from('\uFEFFWSL core installation command completed.', 'utf16le');

    expect(decodeInstallerProcessOutput(utf16le, 'win32')).toContain('WSL core installation');
  });

  it('decodes utf16le Cyrillic output without a BOM', () => {
    const utf16le = Buffer.from(
      'Требуемая операция выполнена успешно. Чтобы заданные изменения вступили в силу, следует перезагрузить систему.',
      'utf16le'
    );

    expect(decodeInstallerProcessOutput(utf16le, 'win32')).toContain(
      'Требуемая операция выполнена успешно'
    );
  });
});
