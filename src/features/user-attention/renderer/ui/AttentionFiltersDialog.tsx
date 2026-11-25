import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from '@renderer/components/ui/dialog';
import { Label } from '@renderer/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@renderer/components/ui/select';
import { ListFilter } from 'lucide-react';

import {
  attentionFilterCount,
  type AttentionFilters,
  type AttentionTeamOption,
  DEFAULT_ATTENTION_FILTERS,
} from '../view-models/filterAttentionEntries';

interface FilterSelectProps {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange(value: string): void;
  disabled?: boolean;
}

function FilterSelect({
  id, label, value, options, onChange, disabled,
}: Readonly<FilterSelectProps>): React.JSX.Element {
  return (
    <div className="grid min-w-0 gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full" data-testid={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

interface AttentionFiltersDialogProps {
  filters: AttentionFilters;
  teams: ReadonlyArray<AttentionTeamOption>;
  onApply(filters: AttentionFilters): void;
}

const ALL_TEAMS = '__all_teams__';

export function AttentionFiltersDialog({
  filters, teams, onApply,
}: Readonly<AttentionFiltersDialogProps>): React.JSX.Element {
  const { t } = useAppTranslation('common');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AttentionFilters>(filters);
  const activeCount = attentionFilterCount(filters);

  const onOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) setDraft({ ...filters });
    setOpen(nextOpen);
  };

  const apply = (): void => {
    onApply(draft);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-9 shrink-0"
          data-testid="attention-filter-trigger">
          <ListFilter className="size-4" aria-hidden="true" />
          {t('attention.filters.title')}
          {activeCount > 0 && (
            <span className="rounded-full bg-surface-raised px-1.5 text-xs tabular-nums"
              data-testid="attention-filter-count">{activeCount}</span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md" data-testid="attention-filter-dialog">
        <DialogHeader>
          <DialogTitle>{t('attention.filters.title')}</DialogTitle>
          <DialogDescription>{t('attention.filters.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <FilterSelect id="attention-filter-type" label={t('attention.filters.itemType')}
            value={draft.type} onChange={(type) =>
              setDraft((current) => ({
                ...current,
                type: type as AttentionFilters['type'],
                // Disabled criteria should never count as active filters.
                ...(type === 'tasks' ? { conversation: 'all' as const } : {}),
                ...(type === 'chats' ? { waiting: 'all' as const } : {}),
              }))}
            options={[
              { value: 'all', label: t('taskFilters.read.all') },
              { value: 'tasks', label: t('attention.tasks') },
              { value: 'chats', label: t('attention.chats') },
            ]} />
          <FilterSelect id="attention-filter-team" label={t('taskFilters.team')}
            value={draft.teamName === null ? ALL_TEAMS : 'team:' + draft.teamName}
            onChange={(value) => setDraft((current) => ({
              ...current, teamName: value === ALL_TEAMS ? null : value.slice('team:'.length),
            }))}
            options={[
              { value: ALL_TEAMS, label: t('taskFilters.allTeams') },
              ...teams.map((team) => ({
                value: 'team:' + team.teamName,
                label: team.displayName,
              })),
              ...(draft.teamName !== null && !teams.some((team) => team.teamName === draft.teamName)
                ? [{ value: 'team:' + draft.teamName, label: draft.teamName }] : []),
            ]} />
          <FilterSelect id="attention-filter-conversation"
            label={t('attention.filters.conversationType')}
            value={draft.conversation}
            disabled={draft.type === 'tasks'}
            onChange={(conversation) => setDraft((current) => ({
              ...current, conversation: conversation as AttentionFilters['conversation'],
            }))}
            options={[
              { value: 'all', label: t('taskFilters.read.all') },
              { value: 'direct', label: t('attention.filters.direct') },
              { value: 'group', label: t('attention.filters.group') },
              { value: 'team-feed', label: t('attention.filters.teamFeed') },
            ]} />
          <FilterSelect id="attention-filter-waiting"
            label={t('attention.filters.waiting')}
            value={draft.waiting}
            disabled={draft.type === 'chats'}
            onChange={(waiting) => setDraft((current) => ({
              ...current, waiting: waiting as AttentionFilters['waiting'],
            }))}
            options={[
              { value: 'all', label: t('taskFilters.read.all') },
              { value: 'day', label: t('attention.filters.olderDay') },
              { value: 'week', label: t('attention.filters.olderWeek') },
            ]} />
        </div>
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button type="button" variant="ghost"
            data-testid="attention-filter-reset"
            onClick={() => setDraft({ ...DEFAULT_ATTENTION_FILTERS })}>
            {t('actions.reset')}
          </Button>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            {t('actions.cancel')}
          </Button>
          <Button type="button" onClick={apply} data-testid="attention-filter-apply">
            {t('taskFilters.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
