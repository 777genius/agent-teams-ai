import { useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { CUSTOM_ROLE, FORBIDDEN_ROLES, NO_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';
import { Check, Loader2, X } from 'lucide-react';

interface MemberRoleEditorProps {
  currentRole: string | undefined;
  onSave: (role: string | undefined) => Promise<void> | void;
  onCancel: () => void;
  saving?: boolean;
}

export const MemberRoleEditor = ({
  currentRole,
  onSave,
  onCancel,
  saving,
}: MemberRoleEditorProps): React.JSX.Element => {
  const isPreset = currentRole && (PRESET_ROLES as readonly string[]).includes(currentRole);
  const [selectValue, setSelectValue] = useState<string>(
    !currentRole ? NO_ROLE : isPreset ? currentRole : CUSTOM_ROLE
  );
  const [customInput, setCustomInput] = useState(isPreset ? '' : (currentRole ?? ''));
  const [error, setError] = useState<string | null>(null);

  const showCustomInput = selectValue === CUSTOM_ROLE;

  const handleSelectChange = (value: string): void => {
    setSelectValue(value);
    setError(null);
    if (value !== CUSTOM_ROLE) {
      setCustomInput('');
    }
  };

  const handleSave = (): void => {
    if (selectValue === NO_ROLE) {
      void onSave(undefined);
      return;
    }
    if (selectValue !== CUSTOM_ROLE) {
      void onSave(selectValue);
      return;
    }
    const trimmed = customInput.trim();
    if (!trimmed) {
      setError('Role cannot be empty');
      return;
    }
    if (FORBIDDEN_ROLES.has(trimmed.toLowerCase())) {
      setError('This role is reserved');
      return;
    }
    void onSave(trimmed);
  };

  return (
    <div className="flex items-center gap-1.5">
      <Select value={selectValue} onValueChange={handleSelectChange}>
        <SelectTrigger className="h-7 w-32 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_ROLE}>No role</SelectItem>
          {PRESET_ROLES.map((r) => (
            <SelectItem key={r} value={r}>
              {r}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_ROLE}>Custom...</SelectItem>
        </SelectContent>
      </Select>

      {showCustomInput && (
        <div className="flex flex-col">
          <Input
            value={customInput}
            onChange={(e) => {
              setCustomInput(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') onCancel();
            }}
            placeholder="Enter role..."
            className="h-7 w-28 text-xs"
            autoFocus
          />
          {error && <span className="mt-0.5 text-[10px] text-red-400">{error}</span>}
        </div>
      )}

      <Button variant="ghost" size="icon" className="size-6" onClick={handleSave} disabled={saving}>
        {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
      </Button>
      <Button variant="ghost" size="icon" className="size-6" onClick={onCancel} disabled={saving}>
        <X size={12} />
      </Button>
    </div>
  );
};
