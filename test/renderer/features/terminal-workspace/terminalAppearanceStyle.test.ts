import { DEFAULT_TERMINAL_APPEARANCE_SETTINGS } from '@features/terminal-workspace/renderer/model/terminalAppearanceSettings';
import { createTerminalAppearanceStyle } from '@features/terminal-workspace/renderer/view-models/terminalAppearanceStyle';
import { describe, expect, it } from 'vitest';

describe('terminal appearance style', () => {
  it('projects solid appearance values without activating a configured image', () => {
    const style = asCustomProperties(
      createTerminalAppearanceStyle({
        ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
        backgroundColor: '#123456',
        backgroundImageUrl: 'https://example.test/background.jpg',
        backgroundMode: 'solid',
        backdropBlurPx: 12,
        fontSizePx: 18,
        opacityPercent: 63,
      })
    );

    expect(style).toMatchObject({
      '--agent-terminal-backdrop-blur': '12px',
      '--agent-terminal-background-color': '#123456',
      '--agent-terminal-background-image': 'none',
      '--agent-terminal-background-image-blur': '0px',
      '--agent-terminal-font-size': '18px',
      '--agent-terminal-image-dim-opacity': '0',
      '--agent-terminal-panel-opacity': '0.63',
    });
  });

  it.each([
    ['cover', 'cover', 'no-repeat', 'center'],
    ['contain', 'contain', 'no-repeat', 'center'],
    ['stretch', '100% 100%', 'no-repeat', 'center'],
    ['tile', 'auto', 'repeat', 'top left'],
    ['center', 'auto', 'no-repeat', 'center'],
  ] as const)(
    'projects the %s image fit and image dimming',
    (backgroundImageFit, size, repeat, position) => {
      const style = asCustomProperties(
        createTerminalAppearanceStyle({
          ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
          backgroundImageFit,
          backgroundImageUrl: 'https://example.test/background image.jpg',
          backgroundMode: 'image',
          backdropBlurPx: 7,
          dimBackgroundImage: true,
        })
      );

      expect(style['--agent-terminal-background-image']).toBe(
        'url("https://example.test/background%20image.jpg")'
      );
      expect(style['--agent-terminal-background-size']).toBe(size);
      expect(style['--agent-terminal-background-repeat']).toBe(repeat);
      expect(style['--agent-terminal-background-position']).toBe(position);
      expect(style['--agent-terminal-background-image-blur']).toBe('7px');
      expect(style['--agent-terminal-image-dim-opacity']).toBe('0.42');
    }
  );

  it('disables image-only styles for unsafe URLs and when dimming is off', () => {
    const unsafeStyle = asCustomProperties(
      createTerminalAppearanceStyle({
        ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
        backgroundImageUrl: 'file:///etc/passwd',
        backgroundMode: 'image',
        backdropBlurPx: 20,
      })
    );
    const undimmedStyle = asCustomProperties(
      createTerminalAppearanceStyle({
        ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
        backgroundImageUrl: 'https://example.test/background.jpg',
        backgroundMode: 'image',
        dimBackgroundImage: false,
      })
    );

    expect(unsafeStyle['--agent-terminal-background-image']).toBe('none');
    expect(unsafeStyle['--agent-terminal-background-image-blur']).toBe('0px');
    expect(unsafeStyle['--agent-terminal-image-dim-opacity']).toBe('0');
    expect(undimmedStyle['--agent-terminal-background-image']).toContain(
      'https://example.test/background.jpg'
    );
    expect(undimmedStyle['--agent-terminal-image-dim-opacity']).toBe('0');
  });
});

function asCustomProperties(style: React.CSSProperties): Readonly<Record<string, string>> {
  return style as Readonly<Record<string, string>>;
}
