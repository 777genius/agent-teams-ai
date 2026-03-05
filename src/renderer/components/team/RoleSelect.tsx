import React, { useCallback, useMemo, useState } from 'react';

import { Combobox } from '@renderer/components/ui/combobox';
import { Input } from '@renderer/components/ui/input';
import { CUSTOM_ROLE, FORBIDDEN_ROLES, NO_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';
import { Blocks, BookOpen, Bug, Check, Code2, FileText, Pencil, Shield, Zap } from 'lucide-react';

import type { ComboboxOption } from '@renderer/components/ui/combobox';
import type { LucideIcon } from 'lucide-react';

/** Icon mapping for preset roles. */
const ROLE_ICONS: Record<string, LucideIcon> = {
  architect: Blocks,
  reviewer: BookOpen,
  developer: Code2,
  qa: Bug,
  researcher: BookOpen,
  docs: FileText,
  auditor: Shield,
  optimizer: Zap,
};

const CUSTOM_ICON = Pencil;

interface RoleSelectProps {
  /** Current role selection value (preset role name, CUSTOM_ROLE, or NO_ROLE). */
  value: string;
  /** Called when the user picks a preset role, NO_ROLE, or CUSTOM_ROLE. */
  onValueChange: (value: string) => void;
  /** Current custom role text (only relevant when value === CUSTOM_ROLE). */
  customRole?: string;
  /** Called when the user types a custom role. */
  onCustomRoleChange?: (customRole: string) => void;
  /** Trigger height class, e.g. "h-7" or "h-8". */
  triggerClassName?: string;
  /** Custom input height class. */
  inputClassName?: string;
  /** Show validation error for custom role. */
  customRoleError?: string | null;
  /** Validate custom role on change and return error or null. */
  onCustomRoleValidate?: (role: string) => string | null;
  disabled?: boolean;
}

const roleOptions: ComboboxOption[] = [
  { value: NO_ROLE, label: 'No role' },
  ...PRESET_ROLES.map((role) => ({
    value: role,
    label: role,
  })),
  { value: CUSTOM_ROLE, label: 'Custom role...' },
];

// eslint-disable-next-line sonarjs/function-return-type -- option renderer returns mixed node structure
const renderRoleOption = (option: ComboboxOption, isSelected: boolean): React.ReactNode => {
  const Icon =
    option.value === CUSTOM_ROLE
      ? CUSTOM_ICON
      : option.value === NO_ROLE
        ? null
        : (ROLE_ICONS[option.value] ?? null);

  return (
    <>
      <span className="mr-2 flex size-4 shrink-0 items-center justify-center">
        {isSelected ? (
          <Check className="size-3.5" />
        ) : Icon ? (
          <Icon className="size-3.5 text-[var(--color-text-muted)]" />
        ) : null}
      </span>
      <span className="min-w-0 truncate font-medium text-[var(--color-text)]">{option.label}</span>
    </>
  );
};

export const RoleSelect = ({
  value,
  onValueChange,
  customRole = '',
  onCustomRoleChange,
  triggerClassName,
  inputClassName,
  customRoleError: externalError,
  onCustomRoleValidate,
  disabled,
}: RoleSelectProps): React.JSX.Element => {
  const [internalError, setInternalError] = useState<string | null>(null);
  const error = externalError ?? internalError;

  const handleValueChange = useCallback(
    (newValue: string) => {
      onValueChange(newValue);
      if (newValue !== CUSTOM_ROLE) {
        setInternalError(null);
      }
    },
    [onValueChange]
  );

  const handleCustomChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      onCustomRoleChange?.(val);

      if (onCustomRoleValidate) {
        setInternalError(onCustomRoleValidate(val));
      } else if (FORBIDDEN_ROLES.has(val.trim().toLowerCase())) {
        setInternalError('This role is reserved');
      } else {
        setInternalError(null);
      }
    },
    [onCustomRoleChange, onCustomRoleValidate]
  );

  const selectedLabel = useMemo(() => {
    const opt = roleOptions.find((o) => o.value === value);
    return opt?.label;
  }, [value]);

  return (
    <div className="space-y-1">
      <Combobox
        options={roleOptions}
        value={value}
        onValueChange={handleValueChange}
        placeholder={selectedLabel ?? 'No role'}
        searchPlaceholder="Search roles..."
        emptyMessage="No roles found."
        disabled={disabled}
        className={triggerClassName}
        renderOption={renderRoleOption}
      />
      {value === CUSTOM_ROLE && onCustomRoleChange ? (
        <div>
          <Input
            className={inputClassName ?? 'h-8 text-xs'}
            value={customRole}
            onChange={handleCustomChange}
            placeholder="Enter custom role..."
            autoFocus
          />
          {error ? <span className="mt-0.5 block text-[10px] text-red-400">{error}</span> : null}
        </div>
      ) : null}
    </div>
  );
};
