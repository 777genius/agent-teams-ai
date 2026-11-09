import { afterEach, describe, expect, it, vi } from 'vitest';

import { listLocalFontFamilies } from '@features/appearance/renderer';

interface FontAccessWindow extends Window {
  queryLocalFonts?: () => Promise<{ family: string }[]>;
}

afterEach(() => {
  delete (window as FontAccessWindow).queryLocalFonts;
});

describe('local font discovery', () => {
  it('gracefully reports browsers with no Local Font Access API', async () => {
    expect(await listLocalFontFamilies()).toBeNull();
  });

  it('uses only safe distinct family names returned by permission-granted browser API', async () => {
    const queryLocalFonts = vi.fn(async () => [
      { family: ' Georgia ' },
      { family: 'Noto Sans' },
      { family: 'Georgia' },
      { family: 'inject; font-size:999px' },
      { family: 'a"b' },
      { family: '' },
    ]);
    Object.defineProperty(window, 'queryLocalFonts', {
      configurable: true, value: queryLocalFonts,
    });
    expect(await listLocalFontFamilies()).toEqual(['Georgia', 'Noto Sans']);
    expect(queryLocalFonts).toHaveBeenCalledOnce();
  });

  it('propagates denied font permissions for the UI to explain and offer manual entry', async () => {
    Object.defineProperty(window, 'queryLocalFonts', {
      configurable: true,
      value: vi.fn(async () => { throw new DOMException('Denied', 'NotAllowedError'); }),
    });
    await expect(listLocalFontFamilies()).rejects.toMatchObject({ name: 'NotAllowedError' });
  });
});
