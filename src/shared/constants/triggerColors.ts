/**
 * Preset color palette for notification triggers.
 * Shared between main and renderer processes.
 *
 * Supports both preset color keys and custom hex strings (e.g., '#ff6600').
 */

export type TriggerColorKey =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'cyan';

/** Color value: either a preset key or a custom hex string like '#ff6600'. */
export type TriggerColor = TriggerColorKey | `#${string}`;

export interface TriggerColorDef {
  key: string;
  label: string;
  hex: string;
}

export const TRIGGER_COLORS: TriggerColorDef[] = [
  { key: 'red', label: 'Red', hex: '#ef4444' },
  { key: 'orange', label: 'Orange', hex: '#f97316' },
  { key: 'yellow', label: 'Yellow', hex: '#eab308' },
  { key: 'green', label: 'Green', hex: '#22c55e' },
  { key: 'blue', label: 'Blue', hex: '#3b82f6' },
  { key: 'purple', label: 'Purple', hex: '#a855f7' },
  { key: 'pink', label: 'Pink', hex: '#ec4899' },
  { key: 'cyan', label: 'Cyan', hex: '#06b6d4' },
];

const DEFAULT_TRIGGER_COLOR: TriggerColorKey = 'red';

const TRIGGER_COLOR_MAP = new Map<string, TriggerColorDef>(TRIGGER_COLORS.map((c) => [c.key, c]));

const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

/** Check if value is a preset color key. */
export function isPresetColorKey(value: string | undefined): value is TriggerColorKey {
  return TRIGGER_COLOR_MAP.has(value ?? '');
}

/**
 * Resolve a color value (preset key or hex string) to a TriggerColorDef.
 * Custom hex strings return a synthetic def with key and label set to the hex value.
 */
export function getTriggerColorDef(color: TriggerColor | undefined): TriggerColorDef {
  if (!color) return TRIGGER_COLOR_MAP.get(DEFAULT_TRIGGER_COLOR) ?? TRIGGER_COLORS[0];
  const preset = TRIGGER_COLOR_MAP.get(color);
  if (preset) return preset;
  // Treat as custom hex
  if (HEX_COLOR_RE.test(color)) return { key: color, label: color, hex: color };
  return TRIGGER_COLOR_MAP.get(DEFAULT_TRIGGER_COLOR) ?? TRIGGER_COLORS[0];
}

/** Resolve any TriggerColor to its hex value. */
export function resolveColorHex(color: TriggerColor | undefined): string {
  return getTriggerColorDef(color).hex;
}

/**
 * Tailwind highlight classes for chat group rings (error navigation).
 */
export const HIGHLIGHT_CLASSES: Record<TriggerColorKey, string> = {
  red: 'ring-2 ring-red-500/30 bg-red-500/5',
  orange: 'ring-2 ring-orange-500/30 bg-orange-500/5',
  yellow: 'ring-2 ring-yellow-500/30 bg-yellow-500/5',
  green: 'ring-2 ring-green-500/30 bg-green-500/5',
  blue: 'ring-2 ring-blue-500/30 bg-blue-500/5',
  purple: 'ring-2 ring-purple-500/30 bg-purple-500/5',
  pink: 'ring-2 ring-pink-500/30 bg-pink-500/5',
  cyan: 'ring-2 ring-cyan-500/30 bg-cyan-500/5',
};

/**
 * Get highlight classes for a color, supporting custom hex.
 * Returns { className, style } — use className for presets, style for custom hex.
 */
export function getHighlightProps(color: TriggerColor | undefined): {
  className: string;
  style?: React.CSSProperties;
} {
  const key = color ?? DEFAULT_TRIGGER_COLOR;
  if (isPresetColorKey(key)) return { className: HIGHLIGHT_CLASSES[key] };
  const hex = resolveColorHex(key);
  return {
    className: 'ring-2',
    style: { boxShadow: `0 0 0 2px ${hex}4D`, backgroundColor: `${hex}0D` },
  };
}

/**
 * Tailwind highlight classes for tool item rings (pulsing highlight).
 */
export const TOOL_HIGHLIGHT_CLASSES: Record<TriggerColorKey, string> = {
  red: 'ring-2 ring-red-500 bg-red-500/10 animate-pulse',
  orange: 'ring-2 ring-orange-500 bg-orange-500/10 animate-pulse',
  yellow: 'ring-2 ring-yellow-500 bg-yellow-500/10 animate-pulse',
  green: 'ring-2 ring-green-500 bg-green-500/10 animate-pulse',
  blue: 'ring-2 ring-blue-500 bg-blue-500/10 animate-pulse',
  purple: 'ring-2 ring-purple-500 bg-purple-500/10 animate-pulse',
  pink: 'ring-2 ring-pink-500 bg-pink-500/10 animate-pulse',
  cyan: 'ring-2 ring-cyan-500 bg-cyan-500/10 animate-pulse',
};

/**
 * Get tool highlight classes for a color, supporting custom hex.
 */
export function getToolHighlightProps(color: TriggerColor | undefined): {
  className: string;
  style?: React.CSSProperties;
} {
  const key = color ?? DEFAULT_TRIGGER_COLOR;
  if (isPresetColorKey(key)) return { className: TOOL_HIGHLIGHT_CLASSES[key] };
  const hex = resolveColorHex(key);
  return {
    className: 'ring-2 animate-pulse',
    style: { boxShadow: `0 0 0 2px ${hex}`, backgroundColor: `${hex}1A` },
  };
}
