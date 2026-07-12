import { useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
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
import { MemberSelect } from '@renderer/components/ui/MemberSelect';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';
import { TiptapEditor } from '@renderer/components/ui/tiptap';
import { useChipDraftPersistence } from '@renderer/hooks/useChipDraftPersistence';
import { useDraftPersistence } from '@renderer/hooks/useDraftPersistence';
import { useTaskSuggestions } from '@renderer/hooks/useTaskSuggestions';
import { useStore } from '@renderer/store';
import { selectTeamDataForName } from '@renderer/store/slices/teamSlice';
import { chipToken, serializeChipsWithText } from '@renderer/types/inlineChip';
import {
  type CreateTaskSubmitGate,
  type PendingCreateTaskCommand,
  resetCreateTaskSubmit,
  resolveCreateTaskCommand,
  tryBeginCreateTaskSubmit,
} from '@renderer/utils/createTaskCommandIdentity';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { isImeComposing } from '@renderer/utils/imeComposition';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import {
  extractTaskRefsFromText,
  stripEncodedTaskReferenceMetadata,
} from '@renderer/utils/taskReferenceUtils';
import { deriveTaskDisplayId, formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import { getTeamTaskWorkflowColumn } from '@shared/utils/teamTaskState';
import { AlertTriangle, ChevronDown, ChevronRight, Search } from 'lucide-react';

import type { InlineChip } from '@renderer/types/inlineChip';
import type { MentionSuggestion } from '@renderer/types/mention';
import type { CreateTaskRequest, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

interface CreateTaskDialogProps {
  open: boolean;
  teamName: string;
  members: ResolvedTeamMember[];
  tasks: TeamTaskWithKanban[];
  isTeamAlive?: boolean;
  defaultSubject?: string;
  defaultDescription?: string;
  defaultOwner?: string;
  defaultStartImmediately?: boolean;
  defaultChip?: InlineChip;
  onClose: () => void;
  onSubmit: (request: CreateTaskRequest) => Promise<void>;
  submitting?: boolean;
}

export const CreateTaskDialog = ({
  open,
  teamName,
  members,
  tasks,
  isTeamAlive = false,
  defaultSubject = '',
  defaultDescription = '',
  defaultOwner = '',
  defaultStartImmediately,
  defaultChip,
  onClose,
  onSubmit,
  submitting = false,
}: CreateTaskDialogProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const projectPath = useStore(
    (s) => selectTeamDataForName(s, teamName)?.config.projectPath ?? null
  );
  const { suggestions: taskSuggestions } = useTaskSuggestions(teamName);
  const [subject, setSubject] = useState(defaultSubject);
  const descriptionDraft = useDraftPersistence({
    key: `createTask:${teamName}:description`,
    initialValue: defaultDescription || undefined,
  });
  const descChipDraft = useChipDraftPersistence(`createTask:${teamName}:descChips`);
  const [owner, setOwner] = useState<string>(defaultOwner);
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  const [related, setRelated] = useState<string[]>([]);
  const [startImmediately, setStartImmediately] = useState(true);
  const promptDraft = useDraftPersistence({ key: `createTask:${teamName}:prompt` });
  const [blockedBySearch, setBlockedBySearch] = useState('');
  const [relatedSearch, setRelatedSearch] = useState('');
  const [showOptionalFields, setShowOptionalFields] = useState(false);
  const prevOpenRef = useRef(false);
  const pendingCommandRef = useRef<PendingCreateTaskCommand | null>(null);
  const submitGateRef = useRef<CreateTaskSubmitGate>({ inFlight: false });

  // Reset form when dialog opens (avoid setState during render)
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      pendingCommandRef.current = null;
      resetCreateTaskSubmit(submitGateRef.current);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync on prop change
      setSubject(defaultSubject);
      if (defaultChip) {
        const token = chipToken(defaultChip);
        descriptionDraft.setValue(token + '\n');
        descChipDraft.setChips([defaultChip]);
      } else if (defaultDescription) {
        descriptionDraft.setValue(defaultDescription);
        descChipDraft.clearChipDraft();
      } else {
        descriptionDraft.clearDraft();
        descChipDraft.clearChipDraft();
      }
      setOwner(defaultOwner);
      setBlockedBy([]);
      setRelated([]);
      setStartImmediately(defaultStartImmediately ?? isTeamAlive);
      promptDraft.clearDraft();
      setBlockedBySearch('');
      setRelatedSearch('');
      setShowOptionalFields(false);
    }
    if (!open && prevOpenRef.current) {
      pendingCommandRef.current = null;
      resetCreateTaskSubmit(submitGateRef.current);
    }
    prevOpenRef.current = open;
  }, [
    open,
    defaultSubject,
    defaultDescription,
    defaultOwner,
    defaultStartImmediately,
    defaultChip,
    isTeamAlive,
    descriptionDraft,
    descChipDraft,
    promptDraft,
  ]);

  useEffect(() => {
    if (!submitting) {
      resetCreateTaskSubmit(submitGateRef.current);
    }
  }, [submitting]);

  const mentionSuggestions = useMemo<MentionSuggestion[]>(
    () =>
      members.map((m) => ({
        id: m.name,
        name: m.name,
        subtitle: formatAgentRole(m.role) ?? formatAgentRole(m.agentType) ?? undefined,
        color: colorMap.get(m.name),
      })),
    [members, colorMap]
  );

  const requiresOwner = defaultStartImmediately === true;
  const canSubmit = subject.trim().length > 0 && !submitting && (!requiresOwner || !!owner);

  // Only show non-internal, non-deleted tasks as candidates for blocking
  const availableTasks = tasks.filter(
    (t) => t.status !== 'deleted' && getTeamTaskWorkflowColumn(t) !== 'approved'
  );

  const toggleBlockedBy = (taskId: string): void => {
    setBlockedBy((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]
    );
  };

  const toggleRelated = (taskId: string): void => {
    setRelated((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]
    );
  };

  const handleSubmit = (): void => {
    if (!canSubmit || !tryBeginCreateTaskSubmit(submitGateRef.current)) return;
    const trimmedDescription = stripEncodedTaskReferenceMetadata(descriptionDraft.value.trim());
    const trimmedPrompt = stripEncodedTaskReferenceMetadata(promptDraft.value.trim());
    const serializedDesc = serializeChipsWithText(trimmedDescription, descChipDraft.chips);
    const descriptionTaskRefs = extractTaskRefsFromText(descriptionDraft.value, taskSuggestions);
    const promptTaskRefs = trimmedPrompt
      ? extractTaskRefsFromText(promptDraft.value, taskSuggestions)
      : [];
    const request: CreateTaskRequest = {
      subject: subject.trim(),
      description: serializedDesc || undefined,
      owner: owner || undefined,
      blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
      related: related.length > 0 ? related : undefined,
      prompt: trimmedPrompt || undefined,
      startImmediately,
      descriptionTaskRefs,
      promptTaskRefs,
    };
    pendingCommandRef.current = resolveCreateTaskCommand(
      pendingCommandRef.current,
      teamName,
      request
    );
    void onSubmit({ ...request, command: pendingCommandRef.current.identity }).finally(() => {
      resetCreateTaskSubmit(submitGateRef.current);
    });
  };

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      onClose();
    }
  };

  const assigneeField = (
    <div className="grid gap-2">
      <Label className={requiresOwner ? undefined : 'label-optional'}>
        {requiresOwner ? t('tasks.createTask.assignee') : t('tasks.createTask.assigneeOptional')}
      </Label>
      <MemberSelect
        members={members}
        value={owner || null}
        onChange={(v) => setOwner(v ?? '')}
        placeholder={
          requiresOwner
            ? t('tasks.createTask.selectMember')
            : t('tasks.createTask.selectMemberOptional')
        }
        allowUnassigned={!requiresOwner}
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[580px]">
        <DialogHeader>
          <DialogTitle>{t('tasks.createTask.title')}</DialogTitle>
          <DialogDescription>{t('tasks.createTask.description')}</DialogDescription>
        </DialogHeader>

        {!isTeamAlive ? (
          <div
            className="flex items-start gap-2 rounded-md border px-3 py-2"
            style={{
              backgroundColor: 'var(--warning-bg)',
              borderColor: 'var(--warning-border)',
              color: 'var(--warning-text)',
            }}
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <p className="text-xs leading-relaxed">
              {t('tasks.createTask.offlineNotice.before')}{' '}
              <strong>{t('tasks.createTask.todo')}</strong>{' '}
              {t('tasks.createTask.offlineNotice.after')}
            </p>
          </div>
        ) : null}

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="task-subject">{t('tasks.createTask.subject')}</Label>
            <Input
              id="task-subject"
              placeholder={t('tasks.createTask.subjectPlaceholder')}
              value={subject}
              autoFocus
              onChange={(e) => setSubject(e.target.value)}
              onKeyDown={(e) => {
                if (!isImeComposing(e) && e.key === 'Enter' && canSubmit) handleSubmit();
              }}
            />
          </div>

          {assigneeField}

          {/* Toggle button for optional fields */}
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
            onClick={() => setShowOptionalFields((prev) => !prev)}
          >
            {showOptionalFields ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>
              {showOptionalFields
                ? t('tasks.createTask.hideOptionalFields')
                : t('tasks.createTask.showOptionalFields')}
            </span>
          </button>

          {/* Collapsible optional fields */}
          <div
            className="grid overflow-hidden transition-all duration-200 ease-in-out"
            style={{ gridTemplateRows: showOptionalFields ? '1fr' : '0fr' }}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label className="label-optional">
                    {t('tasks.createTask.descriptionOptional')}
                  </Label>
                  <TiptapEditor
                    content={descriptionDraft.value}
                    onChange={descriptionDraft.setValue}
                    placeholder={t('tasks.createTask.detailsPlaceholder')}
                    minHeight="100px"
                    maxHeight="200px"
                    toolbar
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="task-prompt" className="label-optional">
                    {t('tasks.createTask.promptOptional')}
                  </Label>
                  <MentionableTextarea
                    id="task-prompt"
                    placeholder={t('tasks.createTask.promptPlaceholder')}
                    value={promptDraft.value}
                    onValueChange={promptDraft.setValue}
                    suggestions={mentionSuggestions}
                    taskSuggestions={taskSuggestions}
                    projectPath={projectPath}
                    minRows={3}
                    maxRows={12}
                    footerRight={
                      promptDraft.isSaved ? (
                        <span className="text-[10px] text-[var(--color-text-muted)]">
                          {t('tasks.createTask.saved')}
                        </span>
                      ) : null
                    }
                  />
                </div>

                {availableTasks.length > 0 ? (
                  <div className="grid gap-2">
                    <Label className="label-optional">
                      {t('tasks.createTask.blockedByOptional')}
                    </Label>
                    <div className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
                      {availableTasks.length > 3 ? (
                        <div className="relative border-b border-[var(--color-border)] px-2 py-1.5">
                          <Search
                            size={12}
                            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                          />
                          <input
                            type="text"
                            placeholder={t('tasks.createTask.searchTasks')}
                            value={blockedBySearch}
                            onChange={(e) => setBlockedBySearch(e.target.value)}
                            className="w-full bg-transparent py-0.5 pl-5 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
                          />
                        </div>
                      ) : null}
                      <div className="max-h-[108px] overflow-y-auto p-1.5">
                        {availableTasks
                          .filter(
                            (t) =>
                              !blockedBySearch ||
                              t.subject.toLowerCase().includes(blockedBySearch.toLowerCase()) ||
                              t.id.includes(blockedBySearch) ||
                              t.displayId?.includes(blockedBySearch)
                          )
                          .map((t) => {
                            const isSelected = blockedBy.includes(t.id);
                            return (
                              <button
                                key={t.id}
                                type="button"
                                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                                  isSelected
                                    ? 'bg-blue-500/15 text-blue-300'
                                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]'
                                }`}
                                onClick={() => toggleBlockedBy(t.id)}
                              >
                                <span
                                  className={`flex size-3.5 shrink-0 items-center justify-center rounded-sm border text-[9px] ${
                                    isSelected
                                      ? 'border-blue-400 bg-blue-500/30 text-blue-300'
                                      : 'border-[var(--color-border-emphasis)]'
                                  }`}
                                >
                                  {isSelected ? '\u2713' : ''}
                                </span>
                                <Badge
                                  variant="secondary"
                                  className="shrink-0 px-1 py-0 text-[10px] font-normal"
                                >
                                  {formatTaskDisplayLabel(t)}
                                </Badge>
                                <span className="truncate">{t.subject}</span>
                              </button>
                            );
                          })}
                      </div>
                    </div>
                    {blockedBy.length > 0 ? (
                      <p className="text-[11px] text-yellow-300">
                        {t('tasks.createTask.blockedBySummary', {
                          tasks: blockedBy.map((id) => `#${deriveTaskDisplayId(id)}`).join(', '),
                        })}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {availableTasks.length > 0 ? (
                  <div className="grid gap-2">
                    <Label className="label-optional">
                      {t('tasks.createTask.relatedOptional')}
                    </Label>
                    <div className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
                      {availableTasks.length > 3 ? (
                        <div className="relative border-b border-[var(--color-border)] px-2 py-1.5">
                          <Search
                            size={12}
                            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                          />
                          <input
                            type="text"
                            placeholder={t('tasks.createTask.searchTasks')}
                            value={relatedSearch}
                            onChange={(e) => setRelatedSearch(e.target.value)}
                            className="w-full bg-transparent py-0.5 pl-5 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
                          />
                        </div>
                      ) : null}
                      <div className="max-h-[108px] overflow-y-auto p-1.5">
                        {availableTasks
                          .filter(
                            (t) =>
                              !relatedSearch ||
                              t.subject.toLowerCase().includes(relatedSearch.toLowerCase()) ||
                              t.id.includes(relatedSearch) ||
                              t.displayId?.includes(relatedSearch)
                          )
                          .map((t) => {
                            const isSelected = related.includes(t.id);
                            return (
                              <button
                                key={`related:${t.id}`}
                                type="button"
                                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                                  isSelected
                                    ? 'bg-purple-500/15 text-purple-300'
                                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)]'
                                }`}
                                onClick={() => toggleRelated(t.id)}
                              >
                                <span
                                  className={`flex size-3.5 shrink-0 items-center justify-center rounded-sm border text-[9px] ${
                                    isSelected
                                      ? 'border-purple-400 bg-purple-500/30 text-purple-300'
                                      : 'border-[var(--color-border-emphasis)]'
                                  }`}
                                >
                                  {isSelected ? '\u2713' : ''}
                                </span>
                                <Badge
                                  variant="secondary"
                                  className="shrink-0 px-1 py-0 text-[10px] font-normal"
                                >
                                  {formatTaskDisplayLabel(t)}
                                </Badge>
                                <span className="truncate">{t.subject}</span>
                              </button>
                            );
                          })}
                      </div>
                    </div>
                    {related.length > 0 ? (
                      <p className="text-[11px] text-purple-300">
                        {t('tasks.createTask.relatedSummary', {
                          tasks: related.map((id) => `#${deriveTaskDisplayId(id)}`).join(', '),
                        })}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {owner ? (
            <div className="grid gap-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="task-start-immediately"
                  checked={isTeamAlive ? startImmediately : false}
                  onCheckedChange={(v) => setStartImmediately(v === true)}
                  disabled={!isTeamAlive}
                />
                <Label
                  htmlFor="task-start-immediately"
                  className={`text-xs font-normal ${!isTeamAlive ? 'text-[var(--color-text-muted)]' : ''}`}
                >
                  {t('tasks.createTask.startImmediately')}
                </Label>
              </div>
              {!isTeamAlive ? (
                <p className="text-[10px] text-[var(--color-text-muted)]">
                  {t('tasks.createTask.startOfflineHint')}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            {t('tasks.createTask.cancel')}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? t('tasks.createTask.creating') : t('tasks.createTask.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
