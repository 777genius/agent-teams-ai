/** Explicitly permission-gated local font discovery; never runs on startup. */
import { normalizeFontFamily, uniqueFontFamilies } from '../../core/domain/appearancePreferences';

interface LocalFontData { family: string }

export async function listLocalFontFamilies(): Promise<string[] | null> {
  const fontAccess = (window as Window & {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }).queryLocalFonts;
  if (!fontAccess) return null;

  const fonts = await fontAccess.call(window);
  const families: string[] = [];
  for (const font of fonts) {
    if (typeof font.family !== 'string') continue;
    try {
      const family = normalizeFontFamily(font.family);
      if (family) families.push(family);
    } catch {
      // Ignore names which cannot safely be interpolated as one CSS family.
    }
  }
  return uniqueFontFamilies(families);
}
