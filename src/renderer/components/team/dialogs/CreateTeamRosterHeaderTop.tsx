import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';

export const CreateTeamRosterHeaderTop = ({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  onCheckedChange(checked: boolean): void;
}): React.JSX.Element => (
  <div className="flex items-center gap-2">
    <Checkbox
      id="solo-team"
      checked={checked}
      onCheckedChange={(nextChecked) => onCheckedChange(nextChecked === true)}
    />
    <Label htmlFor="solo-team" className="cursor-pointer text-xs font-normal text-text-secondary">
      {label}
    </Label>
  </div>
);
