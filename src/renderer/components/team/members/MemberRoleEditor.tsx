import { useState } from 'react';

import { RoleSelect } from '@renderer/components/team/RoleSelect';
import { Button } from '@renderer/components/ui/button';
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
      <RoleSelect
        value={selectValue}
        onValueChange={handleSelectChange}
        customRole={customInput}
        onCustomRoleChange={(val) => {
          setCustomInput(val);
          setError(null);
        }}
        triggerClassName="h-7 w-32 text-xs"
        inputClassName="h-7 w-28 text-xs"
        customRoleError={error}
        onCustomRoleValidate={(val) => {
          if (FORBIDDEN_ROLES.has(val.trim().toLowerCase())) return 'This role is reserved';
          return null;
        }}
      />

      <Button variant="ghost" size="icon" className="size-6" onClick={handleSave} disabled={saving}>
        {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
      </Button>
      <Button variant="ghost" size="icon" className="size-6" onClick={onCancel} disabled={saving}>
        <X size={12} />
      </Button>
    </div>
  );
};
