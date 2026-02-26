import { useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { CUSTOM_ROLE, NO_ROLE, PRESET_ROLES } from '@renderer/constants/teamRoles';
import { Loader2 } from 'lucide-react';

const NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

interface AddMemberDialogProps {
  open: boolean;
  teamName: string;
  existingNames: string[];
  onClose: () => void;
  onAdd: (name: string, role?: string) => void;
  adding?: boolean;
}

export const AddMemberDialog = ({
  open,
  teamName,
  existingNames,
  onClose,
  onAdd,
  adding,
}: AddMemberDialogProps): React.JSX.Element => {
  const [name, setName] = useState('');
  const [roleSelect, setRoleSelect] = useState<string>(NO_ROLE);
  const [customRole, setCustomRole] = useState('');
  const [error, setError] = useState<string | null>(null);

  const effectiveRole =
    roleSelect === CUSTOM_ROLE
      ? customRole.trim()
      : roleSelect === NO_ROLE
        ? undefined
        : roleSelect;

  const validate = (): string | null => {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) return 'Name is required';
    if (trimmed.length < 2) return 'Name must be at least 2 characters';
    if (trimmed.length > 30) return 'Name must be at most 30 characters';
    if (!NAME_REGEX.test(trimmed))
      return 'Name must be lowercase alphanumeric with hyphens (e.g. alice, dev-1)';
    if (existingNames.some((n) => n.toLowerCase() === trimmed)) return 'Name is already taken';
    return null;
  };

  const handleSubmit = (): void => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    onAdd(name.trim().toLowerCase(), effectiveRole);
  };

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      setName('');
      setRoleSelect(NO_ROLE);
      setCustomRole('');
      setError(null);
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Member</DialogTitle>
          <DialogDescription>Add a new member to {teamName}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              placeholder="e.g. alice, dev-1"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit();
              }}
              autoFocus
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
          </div>

          <div className="space-y-2">
            <Label className="label-optional">Role (optional)</Label>
            <Select value={roleSelect} onValueChange={setRoleSelect}>
              <SelectTrigger>
                <SelectValue placeholder="No role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ROLE}>No role</SelectItem>
                {PRESET_ROLES.map((role) => (
                  <SelectItem key={role} value={role}>
                    {role}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_ROLE}>Custom...</SelectItem>
              </SelectContent>
            </Select>
            {roleSelect === CUSTOM_ROLE && (
              <Input
                placeholder="Custom role"
                value={customRole}
                onChange={(e) => setCustomRole(e.target.value)}
              />
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={adding}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={adding || !name.trim()}>
            {adding ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
