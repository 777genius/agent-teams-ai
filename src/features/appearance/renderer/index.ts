/** Public browser-safe Appearance feature surface. */
export {
  type AppearancePreferences,
  contrastRatio,
  CUSTOM_THEME_COLOR_KEYS,
  type CustomTheme,
  DEFAULT_APPEARANCE,
  EXAMPLE_THEME,
  formatCustomThemesJson,
  MAX_JSON_LENGTH,
  parseAppearance,
  parseCustomThemesJson,
  type ThemeColorKey,
  type ThemePalette,
  validateCustomThemes,
  ZOOM_PRESETS,
} from '../core/domain/appearancePreferences';
export {
  APPEARANCE_STORAGE_KEY,
  applyCustomThemeToRoot,
  getAppearanceSnapshot,
  getLatestAppearance,
  readAppearance,
  reflectNativeAppearanceZoom,
  saveAppearance,
  setActiveCustomTheme,
  setAppearanceZoom,
  setCustomThemes,
  subscribeAppearance,
} from './adapters/appearanceStore';
export { useAppearancePreferences, useAppearanceZoomController } from './hooks/useAppearance';
export { ThemeJsonEditorDialog } from './ui/ThemeJsonEditorDialog';
