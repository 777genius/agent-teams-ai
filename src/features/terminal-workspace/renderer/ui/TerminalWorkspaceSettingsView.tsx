import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { cn } from '@renderer/lib/utils';
import { Check, Image, Loader2, Palette, RefreshCw, Square, Terminal, X } from 'lucide-react';

import {
  clampTerminalAppearanceNumberInput,
  normalizeTerminalAppearanceColor,
  TERMINAL_BACKDROP_BLUR_RANGE,
  TERMINAL_BACKGROUND_IMAGE_FIT_OPTIONS,
  TERMINAL_BACKGROUND_MODE_OPTIONS,
  TERMINAL_FONT_SIZE_RANGE,
  TERMINAL_OPACITY_RANGE,
  type TerminalAppearanceSettings,
  type TerminalBackgroundImageFit,
  type TerminalBackgroundMode,
} from '../model/terminalAppearanceSettings';

type TeamTFunction = ReturnType<typeof useAppTranslation>['t'];

export type TerminalWorkspaceSettingsActionId = 'bootstrap' | 'refresh-sessions' | 'stop-runtime';

export interface TerminalWorkspaceSettingsOption {
  id: string;
  label: string;
}

export interface TerminalWorkspaceSettingsViewProps {
  appearanceSettings: TerminalAppearanceSettings;
  display: {
    fontScale: string;
    lineWrap: boolean;
    themeId: string;
  };
  fontScaleOptions: readonly TerminalWorkspaceSettingsOption[];
  onAppearanceSettingsChange: (updates: Partial<TerminalAppearanceSettings>) => void;
  onClose: () => void;
  onFontScaleChange: (fontScale: string) => void;
  onLineWrapChange: (lineWrap: boolean) => void;
  onReconnect: () => void;
  onRefreshSessions: () => void;
  onReload: () => void;
  onResetAppearance: () => void;
  onStopRuntime: () => void;
  onThemeChange: (themeId: string) => void;
  pendingAction: TerminalWorkspaceSettingsActionId | null;
  themeOptions: readonly TerminalWorkspaceSettingsOption[];
}

export const TerminalWorkspaceSettingsView = ({
  appearanceSettings,
  display,
  fontScaleOptions,
  onAppearanceSettingsChange,
  onClose,
  onFontScaleChange,
  onLineWrapChange,
  onReconnect,
  onRefreshSessions,
  onReload,
  onResetAppearance,
  onStopRuntime,
  onThemeChange,
  pendingAction,
  themeOptions,
}: TerminalWorkspaceSettingsViewProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const showBackgroundColor = appearanceSettings.backgroundMode !== 'transparent';
  const showBackgroundImageControls = appearanceSettings.backgroundMode === 'image';

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-white/10 bg-transparent text-slate-100"
      data-testid="agent-team-terminal-settings"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-white/[0.025] px-5 py-4 backdrop-blur-xl">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-100">
            {t('terminalWorkspace.settingsTitle')}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            {t('terminalWorkspace.settingsDescription')}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-slate-400 hover:bg-white/[0.07] hover:text-slate-100"
          aria-label={t('terminalWorkspace.closeTerminalSettings')}
          onClick={onClose}
        >
          <X size={14} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-2">
          <TerminalSettingsSection
            icon={<Palette size={14} />}
            title={t('terminalWorkspace.settingsThemeTitle')}
            description={t('terminalWorkspace.settingsThemeDescription')}
          >
            <Select value={display.themeId} onValueChange={onThemeChange}>
              <SelectTrigger
                aria-label={t('terminalWorkspace.settingsThemeAria')}
                className="border-white/10 bg-white/[0.035]"
              >
                <SelectValue placeholder={t('terminalWorkspace.settingsThemePlaceholder')} />
              </SelectTrigger>
              <SelectContent className="z-[100]">
                {themeOptions.map((theme) => (
                  <SelectItem key={theme.id} value={theme.id}>
                    {theme.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </TerminalSettingsSection>

          <TerminalSettingsSection
            icon={<Terminal size={14} />}
            title={t('terminalWorkspace.settingsFontTitle')}
            description={t('terminalWorkspace.settingsFontDescription')}
          >
            <div className="grid grid-cols-[minmax(0,1fr)_6rem] items-end gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="terminal-settings-font-preset" className="text-xs text-slate-300">
                  {t('terminalWorkspace.settingsFontPreset')}
                </Label>
                <Select value={display.fontScale} onValueChange={onFontScaleChange}>
                  <SelectTrigger
                    id="terminal-settings-font-preset"
                    aria-label={t('terminalWorkspace.settingsFontPresetAria')}
                    className="border-white/10 bg-white/[0.035]"
                  >
                    <SelectValue
                      placeholder={t('terminalWorkspace.settingsFontPresetPlaceholder')}
                    />
                  </SelectTrigger>
                  <SelectContent className="z-[100]">
                    {fontScaleOptions.map((fontScale) => (
                      <SelectItem key={fontScale.id} value={fontScale.id}>
                        {fontScale.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="terminal-settings-font-size" className="text-xs text-slate-300">
                  {t('terminalWorkspace.settingsFontSize')}
                </Label>
                <Input
                  id="terminal-settings-font-size"
                  type="number"
                  inputMode="numeric"
                  min={TERMINAL_FONT_SIZE_RANGE.min}
                  max={TERMINAL_FONT_SIZE_RANGE.max}
                  step={1}
                  className="border-white/10 bg-white/[0.035] text-right"
                  value={appearanceSettings.fontSizePx}
                  onChange={(event) =>
                    onAppearanceSettingsChange({
                      fontSizePx: clampTerminalAppearanceNumberInput(
                        event.currentTarget.value,
                        TERMINAL_FONT_SIZE_RANGE
                      ),
                    })
                  }
                />
              </div>
            </div>
          </TerminalSettingsSection>

          <TerminalSettingsSection
            icon={<Image size={14} />}
            title={t('terminalWorkspace.settingsBackgroundTitle')}
            description={t('terminalWorkspace.settingsBackgroundDescription')}
          >
            <div className="grid gap-3">
              <div
                className={cn(
                  'grid items-end gap-3',
                  showBackgroundColor ? 'grid-cols-[minmax(0,1fr)_6rem]' : 'grid-cols-1'
                )}
              >
                <div className="grid gap-1.5">
                  <Label htmlFor="terminal-settings-opacity" className="text-xs text-slate-300">
                    {t('terminalWorkspace.settingsOpacity')}
                  </Label>
                  <input
                    id="terminal-settings-opacity-range"
                    type="range"
                    min={TERMINAL_OPACITY_RANGE.min}
                    max={TERMINAL_OPACITY_RANGE.max}
                    step={1}
                    className="h-9 w-full accent-sky-300"
                    aria-label={t('terminalWorkspace.settingsOpacityAria')}
                    value={appearanceSettings.opacityPercent}
                    onChange={(event) =>
                      onAppearanceSettingsChange({
                        opacityPercent: clampTerminalAppearanceNumberInput(
                          event.currentTarget.value,
                          TERMINAL_OPACITY_RANGE
                        ),
                      })
                    }
                  />
                </div>
                <Input
                  id="terminal-settings-opacity"
                  type="number"
                  inputMode="numeric"
                  min={TERMINAL_OPACITY_RANGE.min}
                  max={TERMINAL_OPACITY_RANGE.max}
                  step={1}
                  className="border-white/10 bg-white/[0.035] text-right"
                  value={appearanceSettings.opacityPercent}
                  onChange={(event) =>
                    onAppearanceSettingsChange({
                      opacityPercent: clampTerminalAppearanceNumberInput(
                        event.currentTarget.value,
                        TERMINAL_OPACITY_RANGE
                      ),
                    })
                  }
                />
              </div>

              <div className="grid grid-cols-[minmax(0,1fr)_6rem] items-end gap-3">
                <div className="grid gap-1.5">
                  <Label
                    htmlFor="terminal-settings-background-mode"
                    className="text-xs text-slate-300"
                  >
                    {t('terminalWorkspace.settingsBackgroundMode')}
                  </Label>
                  <Select
                    value={appearanceSettings.backgroundMode}
                    onValueChange={(backgroundMode) =>
                      onAppearanceSettingsChange({
                        backgroundMode: backgroundMode as TerminalBackgroundMode,
                      })
                    }
                  >
                    <SelectTrigger
                      id="terminal-settings-background-mode"
                      aria-label={t('terminalWorkspace.settingsBackgroundModeAria')}
                      className="border-white/10 bg-white/[0.035]"
                    >
                      <SelectValue placeholder={t('terminalWorkspace.settingsBackgroundMode')} />
                    </SelectTrigger>
                    <SelectContent className="z-[100]">
                      {TERMINAL_BACKGROUND_MODE_OPTIONS.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {formatTerminalBackgroundModeLabel(t, option.id)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {showBackgroundColor ? (
                  <Input
                    type="color"
                    aria-label={t('terminalWorkspace.settingsBackgroundColorAria')}
                    className="h-9 border-white/10 bg-white/[0.035] p-1"
                    value={appearanceSettings.backgroundColor}
                    onChange={(event) =>
                      onAppearanceSettingsChange({
                        backgroundColor: normalizeTerminalAppearanceColor(
                          event.currentTarget.value
                        ),
                      })
                    }
                  />
                ) : null}
              </div>

              {appearanceSettings.backgroundMode === 'transparent' ? (
                <div className="grid gap-1.5">
                  <Label
                    htmlFor="terminal-settings-backdrop-blur"
                    className="text-xs text-slate-300"
                  >
                    {t('terminalWorkspace.settingsBackdropBlur')}
                  </Label>
                  <Input
                    id="terminal-settings-backdrop-blur"
                    type="number"
                    inputMode="numeric"
                    min={TERMINAL_BACKDROP_BLUR_RANGE.min}
                    max={TERMINAL_BACKDROP_BLUR_RANGE.max}
                    step={1}
                    className="max-w-24 border-white/10 bg-white/[0.035] text-right"
                    value={appearanceSettings.backdropBlurPx}
                    onChange={(event) =>
                      onAppearanceSettingsChange({
                        backdropBlurPx: clampTerminalAppearanceNumberInput(
                          event.currentTarget.value,
                          TERMINAL_BACKDROP_BLUR_RANGE
                        ),
                      })
                    }
                  />
                </div>
              ) : null}

              {showBackgroundImageControls ? (
                <>
                  <div className="grid gap-1.5">
                    <Label
                      htmlFor="terminal-settings-background-image"
                      className="text-xs text-slate-300"
                    >
                      {t('terminalWorkspace.settingsImageUrl')}
                    </Label>
                    <Input
                      id="terminal-settings-background-image"
                      type="url"
                      className="border-white/10 bg-white/[0.035]"
                      placeholder="https://..."
                      value={appearanceSettings.backgroundImageUrl}
                      onChange={(event) =>
                        onAppearanceSettingsChange({
                          backgroundImageUrl: event.currentTarget.value,
                        })
                      }
                    />
                  </div>

                  <div className="grid grid-cols-[minmax(0,1fr)_6rem] items-end gap-3">
                    <div className="grid gap-1.5">
                      <Label
                        htmlFor="terminal-settings-background-fit"
                        className="text-xs text-slate-300"
                      >
                        {t('terminalWorkspace.settingsImageFit')}
                      </Label>
                      <Select
                        value={appearanceSettings.backgroundImageFit}
                        onValueChange={(backgroundImageFit) =>
                          onAppearanceSettingsChange({
                            backgroundImageFit: backgroundImageFit as TerminalBackgroundImageFit,
                          })
                        }
                      >
                        <SelectTrigger
                          id="terminal-settings-background-fit"
                          aria-label={t('terminalWorkspace.settingsImageFitAria')}
                          className="border-white/10 bg-white/[0.035]"
                        >
                          <SelectValue placeholder={t('terminalWorkspace.settingsImageFit')} />
                        </SelectTrigger>
                        <SelectContent className="z-[100]">
                          {TERMINAL_BACKGROUND_IMAGE_FIT_OPTIONS.map((option) => (
                            <SelectItem key={option.id} value={option.id}>
                              {formatTerminalBackgroundImageFitLabel(t, option.id)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="terminal-settings-blur" className="text-xs text-slate-300">
                        {t('terminalWorkspace.settingsImageBlur')}
                      </Label>
                      <Input
                        id="terminal-settings-blur"
                        type="number"
                        inputMode="numeric"
                        min={TERMINAL_BACKDROP_BLUR_RANGE.min}
                        max={TERMINAL_BACKDROP_BLUR_RANGE.max}
                        step={1}
                        className="border-white/10 bg-white/[0.035] text-right"
                        value={appearanceSettings.backdropBlurPx}
                        onChange={(event) =>
                          onAppearanceSettingsChange({
                            backdropBlurPx: clampTerminalAppearanceNumberInput(
                              event.currentTarget.value,
                              TERMINAL_BACKDROP_BLUR_RANGE
                            ),
                          })
                        }
                      />
                    </div>
                  </div>

                  <label className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.025] px-3 py-2 text-xs text-slate-300">
                    <Checkbox
                      checked={appearanceSettings.dimBackgroundImage}
                      onCheckedChange={(checked) =>
                        onAppearanceSettingsChange({ dimBackgroundImage: checked === true })
                      }
                    />
                    {t('terminalWorkspace.settingsDimImage')}
                  </label>
                </>
              ) : null}
            </div>
          </TerminalSettingsSection>

          <TerminalSettingsSection
            icon={<Check size={14} />}
            title={t('terminalWorkspace.settingsBehaviorTitle')}
            description={t('terminalWorkspace.settingsBehaviorDescription')}
          >
            <label className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.025] px-3 py-2 text-xs text-slate-300">
              <Checkbox
                checked={display.lineWrap}
                onCheckedChange={(checked) => onLineWrapChange(checked === true)}
              />
              {t('terminalWorkspace.settingsWrapLongOutput')}
            </label>
          </TerminalSettingsSection>

          <TerminalSettingsSection
            icon={<RefreshCw size={14} />}
            title={t('terminalWorkspace.settingsRuntimeTitle')}
            description={t('terminalWorkspace.settingsRuntimeDescription')}
          >
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-white/10 bg-white/[0.025] text-slate-200 hover:bg-white/[0.07]"
                disabled={pendingAction !== null}
                onClick={onReconnect}
              >
                {pendingAction === 'bootstrap' ? (
                  <Loader2 size={13} className="mr-1.5 animate-spin" />
                ) : (
                  <RefreshCw size={13} className="mr-1.5" />
                )}
                {t('terminalWorkspace.settingsReconnect')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-white/10 bg-white/[0.025] text-slate-200 hover:bg-white/[0.07]"
                disabled={pendingAction !== null}
                onClick={onRefreshSessions}
              >
                {pendingAction === 'refresh-sessions' ? (
                  <Loader2 size={13} className="mr-1.5 animate-spin" />
                ) : (
                  <Terminal size={13} className="mr-1.5" />
                )}
                {t('terminalWorkspace.settingsSessions')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-white/10 bg-white/[0.025] text-slate-200 hover:bg-white/[0.07]"
                disabled={pendingAction !== null}
                onClick={onReload}
              >
                <RefreshCw size={13} className="mr-1.5" />
                {t('terminalWorkspace.settingsReload')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-red-500/25 bg-red-500/10 text-red-200 hover:bg-red-500/15"
                disabled={pendingAction !== null}
                onClick={onStopRuntime}
              >
                {pendingAction === 'stop-runtime' ? (
                  <Loader2 size={13} className="mr-1.5 animate-spin" />
                ) : (
                  <Square size={12} className="mr-1.5" />
                )}
                {t('terminalWorkspace.settingsStop')}
              </Button>
            </div>
          </TerminalSettingsSection>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full text-slate-400 hover:bg-white/[0.06] hover:text-slate-100 lg:col-span-2"
            onClick={onResetAppearance}
          >
            {t('terminalWorkspace.settingsResetAppearance')}
          </Button>
        </div>
      </div>
    </div>
  );
};

const TerminalSettingsSection = ({
  children,
  description,
  icon,
  title,
}: {
  children: React.ReactNode;
  description: string;
  icon: React.ReactNode;
  title: string;
}): React.JSX.Element => {
  return (
    <section className="grid gap-3 rounded-md border border-white/10 bg-white/[0.025] p-4">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-sky-200">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-100">{title}</p>
          <p className="mt-0.5 text-xs leading-5 text-slate-400">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
};

function formatTerminalBackgroundModeLabel(t: TeamTFunction, mode: TerminalBackgroundMode): string {
  switch (mode) {
    case 'transparent':
      return t('terminalWorkspace.backgroundModeTransparent');
    case 'solid':
      return t('terminalWorkspace.backgroundModeSolid');
    case 'image':
      return t('terminalWorkspace.backgroundModeImage');
  }
}

function formatTerminalBackgroundImageFitLabel(
  t: TeamTFunction,
  fit: TerminalBackgroundImageFit
): string {
  switch (fit) {
    case 'cover':
      return t('terminalWorkspace.imageFitCover');
    case 'contain':
      return t('terminalWorkspace.imageFitContain');
    case 'stretch':
      return t('terminalWorkspace.imageFitStretch');
    case 'tile':
      return t('terminalWorkspace.imageFitTile');
    case 'center':
      return t('terminalWorkspace.imageFitCenter');
  }
}
