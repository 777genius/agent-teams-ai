/** Public browser-safe Appearance feature surface. */
export {
  type AppearancePreferences,
  contrastRatio,
  CUSTOM_THEME_COLOR_KEYS,
  type CustomTheme,
  DEFAULT_APPEARANCE,
  EXAMPLE_THEME,
  FONT_SIZE_PRESETS,
  formatCustomThemesJson,
  MAX_FONT_SIZE_PERCENT,
  MAX_JSON_LENGTH,
  MIN_FONT_SIZE_PERCENT,
  normalizeFontFamily,
  parseAppearance,
  parseCustomThemesJson,
  type ThemeColorKey,
  type ThemePalette,
  uniqueFontFamilies,
  validateCustomThemes,
  ZOOM_PRESETS,
} from '../core/domain/appearancePreferences';
export {
  APPEARANCE_STORAGE_KEY,
  applyAppearanceTypographyToRoot,
  applyCustomThemeToRoot,
  getAppearanceSnapshot,
  getLatestAppearance,
  readAppearance,
  reflectNativeAppearanceZoom,
  saveAppearance,
  setActiveCustomTheme,
  setAppearanceFontFamily,
  setAppearanceFontSize,
  setAppearanceZoom,
  setCustomThemes,
  subscribeAppearance,
} from './adapters/appearanceStore';
export { listLocalFontFamilies } from './adapters/availableFonts';
export { useAppearancePreferences, useAppearanceTypographyController, useAppearanceZoomController } from './hooks/useAppearance';
export { ThemeJsonEditorDialog } from './ui/ThemeJsonEditorDialog';
