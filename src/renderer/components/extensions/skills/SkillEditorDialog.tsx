import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { MarkdownPreviewPane } from '@renderer/components/team/editor/MarkdownPreviewPane';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Textarea } from '@renderer/components/ui/textarea';
import { useMarkdownScrollSync } from '@renderer/hooks/useMarkdownScrollSync';
import { useStore } from '@renderer/store';
import { SKILL_ROOT_DEFINITIONS } from '@shared/utils/skillRoots';
import { FileSearch, RotateCcw, X } from 'lucide-react';

import { SkillCodeEditor } from './SkillCodeEditor';
import {
  buildSkillDraftFiles,
  buildSkillTemplate,
  readSkillTemplateContent,
  updateSkillTemplateFrontmatter,
} from './skillDraftUtils';
import { toSuggestedSkillFolderName } from './skillFolderNameUtils';
import { resolveSkillProjectPath } from './skillProjectUtils';
import { SkillReviewDialog } from './SkillReviewDialog';
import { validateSkillFolderName } from './skillValidationUtils';

import type {
  SkillDetail,
  SkillInvocationMode,
  SkillReviewPreview,
  SkillRootKind,
} from '@shared/types/extensions';

const SKILL_MARKDOWN_FILENAME = ['SKILL', 'md'].join('.');

type EditorMode = 'create' | 'edit';

interface SkillEditorDialogProps {
  open: boolean;
  mode: EditorMode;
  projectPath: string | null;
  projectLabel: string | null;
  allowCodexRootKind: boolean;
  detail: SkillDetail | null;
  onClose: () => void;
  onSaved: (skillId: string | null) => void;
}

function parseInitialName(detail: SkillDetail | null): string {
  return detail?.item.name ?? '';
}

function parseInitialDescription(detail: SkillDetail | null): string {
  return detail?.item.description ?? '';
}

export const SkillEditorDialog = ({
  open,
  mode,
  projectPath,
  projectLabel,
  allowCodexRootKind,
  detail,
  onClose,
  onSaved,
}: SkillEditorDialogProps): React.JSX.Element => {
  const { t } = useAppTranslation('extensions');
  const containerRef = useRef<HTMLDivElement>(null);
  const editorScrollRef = useRef<HTMLElement | null>(null);
  const rawContentRef = useRef('');
  const previewSkillUpsert = useStore((s) => s.previewSkillUpsert);
  const applySkillUpsert = useStore((s) => s.applySkillUpsert);

  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [rootKind, setRootKind] = useState<SkillRootKind>('claude');
  const [folderName, setFolderName] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [license, setLicense] = useState('');
  const [compatibility, setCompatibility] = useState('');
  const [invocationMode, setInvocationMode] = useState<SkillInvocationMode>('auto');
  const [whenToUse, setWhenToUse] = useState('');
  const [steps, setSteps] = useState('');
  const [notes, setNotes] = useState('');
  const [includeScripts, setIncludeScripts] = useState(false);
  const [includeReferences, setIncludeReferences] = useState(false);
  const [includeAssets, setIncludeAssets] = useState(false);
  const [rawContent, setRawContent] = useState('');
  const [folderNameEdited, setFolderNameEdited] = useState(false);
  const [customMarkdownDetected, setCustomMarkdownDetected] = useState(false);
  const [manualRawEdit, setManualRawEdit] = useState(false);
  const [showAdvancedEditor, setShowAdvancedEditor] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.52);
  const [isResizing, setIsResizing] = useState(false);
  const [reviewPreview, setReviewPreview] = useState<SkillReviewPreview | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const scrollSync = useMarkdownScrollSync(
    showAdvancedEditor,
    detail?.item.id ?? (mode === 'create' ? 'create-skill' : 'edit-skill'),
    { editorScrollRef }
  );

  const applyFormToRawContent = useCallback(
    (
      nextValues: Partial<{
        name: string;
        description: string;
        license: string;
        compatibility: string;
        invocationMode: SkillInvocationMode;
        whenToUse: string;
        steps: string;
        notes: string;
      }>
    ) => {
      const merged = {
        name,
        description,
        license,
        compatibility,
        invocationMode,
        whenToUse,
        steps,
        notes,
        ...nextValues,
      };
      const nextRawContent =
        !manualRawEdit && !customMarkdownDetected
          ? buildSkillTemplate(merged)
          : updateSkillTemplateFrontmatter(rawContentRef.current, merged);

      rawContentRef.current = nextRawContent;
      setRawContent(nextRawContent);
    },
    [
      compatibility,
      description,
      invocationMode,
      license,
      manualRawEdit,
      customMarkdownDetected,
      name,
      notes,
      steps,
      whenToUse,
    ]
  );

  useEffect(() => {
    if (!open) return;

    const item = detail?.item;
    const nextScope = item?.scope ?? (projectPath ? 'project' : 'user');
    const nextRootKind = item?.rootKind ?? 'claude';
    const nextFolderName = item?.folderName ?? '';
    const nextName = parseInitialName(detail);
    const nextDescription = parseInitialDescription(detail);
    const nextLicense = item?.license ?? '';
    const nextCompatibility = item?.compatibility ?? '';
    const nextInvocationMode = item?.invocationMode ?? 'auto';
    const nextWhenToUse = 'Use this skill when the task matches these conditions.';
    const nextSteps = '1. Describe the first step.\n2. Describe the second step.';
    const nextNotes = '- Add caveats, review rules, or references.';
    const nextRawContent =
      detail?.rawContent ??
      buildSkillTemplate({
        name: nextName || 'New Skill',
        description: nextDescription || 'Describe what this skill helps with.',
        license: nextLicense,
        compatibility: nextCompatibility,
        invocationMode: nextInvocationMode,
        whenToUse: nextWhenToUse,
        steps: nextSteps,
        notes: nextNotes,
      });
    const rawInput = readSkillTemplateContent(nextRawContent);
    const suggestedFolderName = toSuggestedSkillFolderName(nextName || 'New Skill');
    const hasCustomMarkdown = mode === 'edit' && rawInput.hasUnstructuredBody;

    setScope(nextScope);
    setRootKind(nextRootKind);
    setFolderName(nextFolderName || suggestedFolderName || nextName || '');
    setFolderNameEdited(Boolean(item?.folderName));
    setName(rawInput.name || nextName || 'New Skill');
    setDescription(
      rawInput.description || nextDescription || 'Describe what this skill helps with.'
    );
    setLicense(rawInput.license ?? nextLicense);
    setCompatibility(rawInput.compatibility ?? nextCompatibility);
    setInvocationMode(rawInput.invocationMode ?? nextInvocationMode);
    setWhenToUse(
      hasCustomMarkdown
        ? (rawInput.bodyMarkdown ?? nextRawContent)
        : (rawInput.whenToUse ?? nextWhenToUse)
    );
    setSteps(hasCustomMarkdown ? '' : (rawInput.steps ?? nextSteps));
    setNotes(hasCustomMarkdown ? '' : (rawInput.notes ?? nextNotes));
    setIncludeScripts(item?.flags.hasScripts ?? false);
    setIncludeReferences(item?.flags.hasReferences ?? false);
    setIncludeAssets(item?.flags.hasAssets ?? false);
    setCustomMarkdownDetected(hasCustomMarkdown);
    rawContentRef.current = nextRawContent;
    setRawContent(nextRawContent);
    setManualRawEdit(false);
    setShowAdvancedEditor(hasCustomMarkdown);
    setReviewPreview(null);
    setReviewOpen(false);
    setReviewLoading(false);
    setSaveLoading(false);
    setMutationError(null);
  }, [allowCodexRootKind, detail, mode, open, projectPath]);

  useEffect(() => {
    if (open) {
      return;
    }

    setReviewPreview(null);
    setReviewOpen(false);
    setReviewLoading(false);
    setSaveLoading(false);
    setMutationError(null);
  }, [open]);

  useEffect(() => {
    if (open && mode === 'create' && scope === 'project' && !projectPath) {
      setScope('user');
    }
  }, [mode, open, projectPath, scope]);

  useEffect(() => {
    if (open && mode === 'create' && rootKind === 'codex' && !allowCodexRootKind) {
      setRootKind('claude');
    }
  }, [allowCodexRootKind, mode, open, rootKind]);

  useEffect(() => {
    rawContentRef.current = rawContent;
  }, [rawContent]);

  const effectiveProjectPath = useMemo(
    () =>
      resolveSkillProjectPath(
        scope,
        projectPath,
        mode === 'edit' ? detail?.item.projectRoot : undefined
      ),
    [detail?.item.projectRoot, mode, projectPath, scope]
  );

  const request = useMemo(
    () => ({
      scope,
      rootKind,
      projectPath: effectiveProjectPath,
      folderName,
      existingSkillId: mode === 'edit' ? detail?.item.id : undefined,
      files: buildSkillDraftFiles({
        rawContent,
        includeScripts,
        includeReferences,
        includeAssets,
      }),
    }),
    [
      detail?.item.id,
      folderName,
      includeAssets,
      includeReferences,
      includeScripts,
      mode,
      rawContent,
      rootKind,
      scope,
      effectiveProjectPath,
    ]
  );
  const draftFilePaths = useMemo(
    () => request.files.map((file) => file.relativePath),
    [request.files]
  );
  const auxiliaryDraftFilePaths = useMemo(
    () => draftFilePaths.filter((filePath) => filePath !== SKILL_MARKDOWN_FILENAME),
    [draftFilePaths]
  );

  const canUseProjectScope = Boolean(projectPath);
  const visibleRootDefinitions = useMemo(
    () =>
      SKILL_ROOT_DEFINITIONS.filter(
        (definition) =>
          definition.rootKind !== 'codex' || allowCodexRootKind || detail?.item.rootKind === 'codex'
      ),
    [allowCodexRootKind, detail?.item.rootKind]
  );
  const instructionsLocked = manualRawEdit || customMarkdownDetected;
  const title = mode === 'create' ? t('skillEditor.title.create') : t('skillEditor.title.edit');
  const descriptionText =
    mode === 'create' ? t('skillEditor.description.create') : t('skillEditor.description.edit');

  function validateBeforeReview(): string | null {
    if (!name.trim()) {
      return 'Add a skill name so people know what this workflow is for.';
    }
    if (!description.trim()) {
      return 'Add a short description so it is clear what this skill helps with.';
    }
    if (!folderName.trim()) {
      return 'Choose a folder name for this skill.';
    }
    const folderNameError = validateSkillFolderName(folderName);
    if (folderNameError) {
      return folderNameError;
    }
    if (scope === 'project' && !effectiveProjectPath) {
      return 'Project skills need an active project.';
    }
    return null;
  }

  const handleMouseMove = useCallback((event: MouseEvent): void => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    setSplitRatio(Math.min(0.75, Math.max(0.25, ratio)));
  }, []);

  const handleMouseUp = useCallback((): void => {
    setIsResizing(false);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [handleMouseMove, handleMouseUp, isResizing]);

  async function handleReview(): Promise<void> {
    const validationError = validateBeforeReview();
    if (validationError) {
      setMutationError(validationError);
      return;
    }
    setReviewLoading(true);
    setMutationError(null);
    try {
      const preview = await previewSkillUpsert(request);
      setReviewPreview(preview);
      setReviewOpen(true);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to review skill changes');
    } finally {
      setReviewLoading(false);
    }
  }

  async function handleConfirmSave(): Promise<void> {
    setSaveLoading(true);
    setMutationError(null);
    try {
      const saved = await applySkillUpsert({
        ...request,
        reviewPlanId: reviewPreview?.planId,
      });
      setReviewOpen(false);
      onSaved(saved?.item.id ?? detail?.item.id ?? null);
      onClose();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to save skill');
    } finally {
      setSaveLoading(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="max-w-6xl gap-0 overflow-hidden p-0">
          <div className="flex max-h-[85vh] min-h-0 flex-col">
            <DialogHeader className="border-b border-border px-6 py-5">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{descriptionText}</DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <div className="space-y-5">
                <section className="space-y-1">
                  <h3 className="text-sm font-semibold text-text">
                    {t('skillEditor.basics.title')}
                  </h3>
                  <p className="text-sm text-text-muted">{t('skillEditor.basics.description')}</p>
                </section>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div className="space-y-2">
                    <Label htmlFor="skill-scope">{t('skillEditor.fields.scope')}</Label>
                    <Select
                      value={scope}
                      onValueChange={(value) => setScope(value as 'user' | 'project')}
                      disabled={mode === 'edit'}
                    >
                      <SelectTrigger id="skill-scope">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">{t('skillEditor.scope.user')}</SelectItem>
                        <SelectItem value="project" disabled={!canUseProjectScope}>
                          {canUseProjectScope
                            ? t('skillEditor.scope.project', {
                                project: projectLabel ?? projectPath,
                              })
                            : t('skillEditor.scope.projectUnavailable')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="skill-root">{t('skillEditor.fields.root')}</Label>
                    <Select
                      value={rootKind}
                      onValueChange={(value) => setRootKind(value as SkillRootKind)}
                      disabled={mode === 'edit'}
                    >
                      <SelectTrigger id="skill-root">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {visibleRootDefinitions.map((definition) => (
                          <SelectItem key={definition.rootKind} value={definition.rootKind}>
                            {definition.directoryName}
                            {definition.audience === 'codex'
                              ? t('skillEditor.root.codexOnly')
                              : t('skillEditor.root.shared')}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="skill-folder">{t('skillEditor.fields.folderName')}</Label>
                    <Input
                      id="skill-folder"
                      value={folderName}
                      onChange={(event) => {
                        setFolderNameEdited(true);
                        setFolderName(event.target.value);
                      }}
                      disabled={mode === 'edit'}
                    />
                    {mode === 'create' && (
                      <p className="text-xs text-text-muted">
                        {t('skillEditor.fields.folderNameHint')}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="skill-invocation">{t('skillEditor.fields.invocation')}</Label>
                    <Select
                      value={invocationMode}
                      onValueChange={(value) => {
                        const nextValue = value as SkillInvocationMode;
                        setInvocationMode(nextValue);
                        applyFormToRawContent({ invocationMode: nextValue });
                      }}
                    >
                      <SelectTrigger id="skill-invocation">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">{t('skillEditor.invocation.auto')}</SelectItem>
                        <SelectItem value="manual-only">
                          {t('skillEditor.invocation.manualOnly')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="skill-name">{t('skillEditor.fields.name')}</Label>
                    <Input
                      id="skill-name"
                      value={name}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setName(nextValue);
                        if (mode === 'create' && !folderNameEdited) {
                          setFolderName(toSuggestedSkillFolderName(nextValue || 'New Skill'));
                        }
                        applyFormToRawContent({ name: nextValue });
                      }}
                      placeholder={t('skillEditor.placeholders.name')}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="skill-license">{t('skillEditor.fields.license')}</Label>
                    <Input
                      id="skill-license"
                      value={license}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setLicense(nextValue);
                        applyFormToRawContent({ license: nextValue });
                      }}
                      placeholder={t('skillEditor.placeholders.license')}
                    />
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="skill-description">{t('skillEditor.fields.description')}</Label>
                    <Input
                      id="skill-description"
                      value={description}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setDescription(nextValue);
                        applyFormToRawContent({ description: nextValue });
                      }}
                      placeholder={t('skillEditor.placeholders.description')}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="skill-compatibility">
                      {t('skillEditor.fields.compatibility')}
                    </Label>
                    <Input
                      id="skill-compatibility"
                      value={compatibility}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setCompatibility(nextValue);
                        applyFormToRawContent({ compatibility: nextValue });
                      }}
                      placeholder={t('skillEditor.placeholders.compatibility')}
                    />
                  </div>
                </div>

                {!customMarkdownDetected && (
                  <>
                    <section className="space-y-1">
                      <h3 className="text-sm font-semibold text-text">
                        {t('skillEditor.instructions.title')}
                      </h3>
                      <p className="text-sm text-text-muted">
                        {t('skillEditor.instructions.description')}
                      </p>
                    </section>

                    <div className="grid gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="skill-when-to-use">
                          {t('skillEditor.fields.whenToUse')}
                        </Label>
                        <Textarea
                          id="skill-when-to-use"
                          value={whenToUse}
                          disabled={instructionsLocked}
                          onChange={(event) => {
                            const nextValue = event.target.value;
                            setWhenToUse(nextValue);
                            applyFormToRawContent({ whenToUse: nextValue });
                          }}
                          placeholder={t('skillEditor.placeholders.whenToUse')}
                          className="min-h-[88px]"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="skill-steps">{t('skillEditor.fields.steps')}</Label>
                        <Textarea
                          id="skill-steps"
                          value={steps}
                          disabled={instructionsLocked}
                          onChange={(event) => {
                            const nextValue = event.target.value;
                            setSteps(nextValue);
                            applyFormToRawContent({ steps: nextValue });
                          }}
                          placeholder={t('skillEditor.placeholders.steps')}
                          className="min-h-[120px]"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="skill-notes">{t('skillEditor.fields.notes')}</Label>
                        <Textarea
                          id="skill-notes"
                          value={notes}
                          disabled={instructionsLocked}
                          onChange={(event) => {
                            const nextValue = event.target.value;
                            setNotes(nextValue);
                            applyFormToRawContent({ notes: nextValue });
                          }}
                          placeholder={t('skillEditor.placeholders.notes')}
                          className="min-h-[88px]"
                        />
                        {instructionsLocked && (
                          <p className="text-xs text-text-muted">
                            {t('skillEditor.instructions.locked')}
                          </p>
                        )}
                      </div>
                    </div>
                  </>
                )}

                <section className="space-y-1">
                  <h3 className="text-sm font-semibold text-text">
                    {t('skillEditor.extraFiles.title')}
                  </h3>
                  <p className="text-sm text-text-muted">
                    {t('skillEditor.extraFiles.description')}
                  </p>
                </section>

                <div className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-text">
                        {t('skillEditor.extraFiles.optionalTitle')}
                      </p>
                      <p className="mt-1 text-xs text-text-muted">
                        {t('skillEditor.extraFiles.optionalDescription')}
                      </p>
                    </div>
                    {mode === 'edit' && (
                      <Badge variant="outline" className="font-normal">
                        {t('skillEditor.extraFiles.lockedForEdits')}
                      </Badge>
                    )}
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <label className="bg-surface-raised/10 flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm">
                      <Checkbox
                        checked={includeReferences}
                        onCheckedChange={(value) => setIncludeReferences(Boolean(value))}
                        className="mt-0.5"
                      />
                      <div>
                        <p className="font-medium text-text">
                          {t('skillEditor.extraFiles.references')}
                        </p>
                        <p className="mt-1 text-xs text-text-muted">
                          {t('skillEditor.extraFiles.referencesDescription')}
                        </p>
                      </div>
                    </label>

                    <label className="bg-surface-raised/10 flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm">
                      <Checkbox
                        checked={includeScripts}
                        onCheckedChange={(value) => setIncludeScripts(Boolean(value))}
                        className="mt-0.5"
                      />
                      <div>
                        <p className="font-medium text-text">
                          {t('skillEditor.extraFiles.scripts')}
                        </p>
                        <p className="mt-1 text-xs text-text-muted">
                          {t('skillEditor.extraFiles.scriptsDescription')}
                        </p>
                      </div>
                    </label>

                    <label className="bg-surface-raised/10 flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm">
                      <Checkbox
                        checked={includeAssets}
                        onCheckedChange={(value) => setIncludeAssets(Boolean(value))}
                        className="mt-0.5"
                      />
                      <div>
                        <p className="font-medium text-text">
                          {t('skillEditor.extraFiles.assets')}
                        </p>
                        <p className="mt-1 text-xs text-text-muted">
                          {t('skillEditor.extraFiles.assetsDescription')}
                        </p>
                      </div>
                    </label>
                  </div>

                  {auxiliaryDraftFilePaths.length > 0 && (
                    <div className="mt-4">
                      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                        {t('skillEditor.extraFiles.addedFiles')}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {auxiliaryDraftFilePaths.map((filePath) => (
                          <Badge key={filePath} variant="outline" className="font-normal">
                            {filePath}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {mutationError && (
                  <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400">
                    {mutationError}
                  </div>
                )}

                <section className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-text">
                        {customMarkdownDetected
                          ? t('skillEditor.advanced.customTitle')
                          : t('skillEditor.advanced.title')}
                      </h3>
                      <p className="text-sm text-text-muted">
                        {customMarkdownDetected
                          ? t('skillEditor.advanced.customDescription')
                          : t('skillEditor.advanced.description')}
                      </p>
                    </div>
                    {!customMarkdownDetected && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowAdvancedEditor((prev) => !prev)}
                      >
                        {showAdvancedEditor
                          ? t('skillEditor.advanced.hide')
                          : t('skillEditor.advanced.show')}
                      </Button>
                    )}
                  </div>

                  {showAdvancedEditor && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="skill-raw">{SKILL_MARKDOWN_FILENAME}</Label>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setManualRawEdit(false);
                            setCustomMarkdownDetected(false);
                            const nextRawContent = buildSkillTemplate({
                              name,
                              description,
                              license,
                              compatibility,
                              invocationMode,
                              whenToUse,
                              steps,
                              notes,
                            });
                            rawContentRef.current = nextRawContent;
                            setRawContent(nextRawContent);
                          }}
                        >
                          <RotateCcw className="mr-1.5 size-3.5" />
                          {t('skillEditor.advanced.resetFromStructuredFields')}
                        </Button>
                      </div>

                      <div
                        ref={containerRef}
                        className="flex h-[520px] min-h-0 overflow-hidden rounded-lg border border-border"
                      >
                        <div className="min-w-0" style={{ width: `${splitRatio * 100}%` }}>
                          <SkillCodeEditor
                            value={rawContent}
                            scrollRef={editorScrollRef}
                            onScroll={scrollSync.handleCodeScroll}
                            onChange={(value) => {
                              setManualRawEdit(true);
                              rawContentRef.current = value;
                              setRawContent(value);

                              const rawInput = readSkillTemplateContent(value);
                              setCustomMarkdownDetected(rawInput.hasUnstructuredBody);
                              if (rawInput.name !== undefined) setName(rawInput.name);
                              if (rawInput.description !== undefined)
                                setDescription(rawInput.description);
                              if (rawInput.license !== undefined) setLicense(rawInput.license);
                              if (rawInput.compatibility !== undefined)
                                setCompatibility(rawInput.compatibility);
                              if (rawInput.invocationMode !== undefined)
                                setInvocationMode(rawInput.invocationMode);
                              if (rawInput.whenToUse !== undefined)
                                setWhenToUse(rawInput.whenToUse);
                              if (rawInput.steps !== undefined) setSteps(rawInput.steps);
                              if (rawInput.notes !== undefined) setNotes(rawInput.notes);
                            }}
                          />
                        </div>
                        <div
                          className={`w-1 shrink-0 cursor-col-resize border-x border-border ${
                            isResizing ? 'bg-blue-500/50' : 'hover:bg-blue-500/30'
                          }`}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            setIsResizing(true);
                          }}
                        />
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <MarkdownPreviewPane
                            content={rawContent}
                            baseDir={detail?.item.skillDir}
                            scrollRef={scrollSync.previewScrollRef}
                            onScroll={scrollSync.handlePreviewScroll}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </section>
              </div>
            </div>

            <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-border bg-surface px-6 py-4 shadow-[0_-8px_24px_rgba(0,0,0,0.08)]">
              <Button variant="outline" onClick={onClose}>
                <X className="mr-1.5 size-3.5" />
                {t('skillEditor.actions.cancel')}
              </Button>
              <div className="min-w-64 flex-1">
                <p className="text-sm text-text-muted">{t('skillEditor.review.hint')}</p>
                {mutationError && <p className="mt-1 text-sm text-red-400">{mutationError}</p>}
              </div>
              <Button onClick={() => void handleReview()} disabled={reviewLoading || saveLoading}>
                <FileSearch className="mr-1.5 size-3.5" />
                {reviewLoading
                  ? t('skillEditor.actions.preparing')
                  : mode === 'create'
                    ? t('skillEditor.actions.reviewAndCreate')
                    : t('skillEditor.actions.reviewAndSave')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <SkillReviewDialog
        open={reviewOpen}
        preview={reviewPreview}
        loading={saveLoading}
        error={mutationError}
        onClose={() => setReviewOpen(false)}
        onConfirm={() => void handleConfirmSave()}
        confirmLabel={
          mode === 'create'
            ? t('skillEditor.actions.createSkill')
            : t('skillEditor.actions.saveSkill')
        }
        reviewLabel={
          mode === 'create' ? t('skillEditor.review.creating') : t('skillEditor.review.saving')
        }
      />
    </>
  );
};
