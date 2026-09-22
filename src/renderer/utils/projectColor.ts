import type { TeamColorSet } from '@renderer/constants/teamColors';

function hashStringToHue(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ((hash % 360) + 360) % 360;
}

export interface ProjectColorSet {
  border: string;
  glow: string;
  icon: string;
  text: string;
}

export function projectColor(name: string, isLight = false): ProjectColorSet {
  const hue = hashStringToHue(name);
  if (isLight) {
    return {
      border: `hsla(${hue}, 70%, 40%, 0.7)`,
      glow: `hsla(${hue}, 70%, 40%, 0.08)`,
      icon: `hsla(${hue}, 70%, 40%, 0.85)`,
      text: `hsla(${hue}, 50%, 35%, 0.9)`,
    };
  }
  return {
    border: `hsla(${hue}, 70%, 55%, 0.5)`,
    glow: `hsla(${hue}, 70%, 55%, 0.06)`,
    icon: `hsla(${hue}, 70%, 65%, 0.8)`,
    text: `hsla(${hue}, 40%, 65%, 0.55)`,
  };
}

/** Generate a TeamColorSet from any name (deterministic hue). */
export function nameColorSet(name: string, isLight = false): TeamColorSet {
  const hue = hashStringToHue(name);
  if (isLight) {
    return {
      border: `hsl(${hue}, 70%, 40%)`,
      badge: `hsla(${hue}, 70%, 40%, 0.1)`,
      text: `hsla(${hue}, 50%, 35%, 0.9)`,
    };
  }
  return {
    border: `hsl(${hue}, 70%, 55%)`,
    badge: `hsla(${hue}, 70%, 55%, 0.08)`,
    text: `hsla(${hue}, 35%, 70%, 0.55)`,
  };
}
