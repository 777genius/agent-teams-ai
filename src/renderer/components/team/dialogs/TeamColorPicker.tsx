import { Label } from '@renderer/components/ui/label';
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { cn } from '@renderer/lib/utils';

const TEAM_COLOR_NAMES = [
  'blue',
  'green',
  'red',
  'yellow',
  'purple',
  'cyan',
  'orange',
  'pink',
] as const;

export const TeamColorPicker = ({
  color,
  onChange,
  isLight,
  label,
}: {
  color: string;
  onChange: (color: string) => void;
  isLight: boolean;
  label: string;
}): React.JSX.Element => {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-2">
        {TEAM_COLOR_NAMES.map((colorName) => {
          const colorSet = getTeamColorSet(colorName);
          const isSelected = color === colorName;
          return (
            <button
              key={colorName}
              type="button"
              className={cn(
                'flex size-7 items-center justify-center rounded-full border-2 transition-all',
                isSelected ? 'scale-110' : 'opacity-70 hover:opacity-100'
              )}
              style={{
                backgroundColor: getThemedBadge(colorSet, isLight),
                borderColor: isSelected ? colorSet.border : 'transparent',
              }}
              title={colorName}
              onClick={() => onChange(isSelected ? '' : colorName)}
            >
              <span
                className="size-3.5 rounded-full"
                style={{ backgroundColor: colorSet.border }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
};
