import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import { FileSearch, RotateCcw, X } from 'lucide-react';

import { SkillCodeEditor } from './SkillCodeEditor';
import { SkillReviewDialog } from './SkillReviewDialog';
import {
  buildSkillDraftFiles,
  buildSkillTemplate,
  readSkillTemplateContent,
  updateSkillTemplateFrontmatter,
} from './skillDraftUtils';

import type {
  SkillDetail,
  SkillInvocationMode,
  SkillReviewPreview,
} from '@shared/types/extensions';

type EditorMode = 'create' | 'edit';

interface SkillEditorDialogProps {
  open: boolean;
  mode: EditorMode;
  projectPath: string | null;
  projectLabel: string | null;
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

function toSuggestedFolderName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export const SkillEditorDialog = ({
  open,
  mode,
  projectPath,
  projectLabel,
  detail,
  onClose,
  onSaved,
}: SkillEditorDialogProps): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorScrollRef = useRef<HTMLElement | null>(null);
  const rawContentRef = useRef('');
  const previewSkillUpsert = useStore((s) => s.previewSkillUpsert);
  const applySkillUpsert = useStore((s) => s.applySkillUpsert);

  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [rootKind, setRootKind] = useState<'claude' | 'cursor' | 'agents'>('claude');
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
    const suggestedFolderName = toSuggestedFolderName(nextName || 'New Skill');
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
  }, [detail, mode, open, projectPath]);

  useEffect(() => {
    rawContentRef.current = rawContent;
  }, [rawContent]);

  const request = useMemo(
    () => ({
      scope,
      rootKind,
      projectPath: scope === 'project' ? (projectPath ?? undefined) : undefined,
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
      projectPath,
      rawContent,
      rootKind,
      scope,
    ]
  );
  const draftFilePaths = useMemo(
    () => request.files.map((file) => file.relativePath),
    [request.files]
  );
  const auxiliaryDraftFilePaths = useMemo(
    () => draftFilePaths.filter((filePath) => filePath !== 'SKILL.md'),
    [draftFilePaths]
  );

  const canUseProjectScope = Boolean(projectPath);
  const instructionsLocked = manualRawEdit || customMarkdownDetected;
  const title = mode === 'create' ? 'Create skill' : 'Edit skill';
  const descriptionText =
    mode === 'create'
      ? 'Describe the workflow in plain language, review the files that will be created, then save it.'
      : 'Update this skill, review the resulting file changes, then save it.';

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
    if (scope === 'project' && !projectPath) {
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
                  <h3 className="text-sm font-semibold text-text">1. Basics</h3>
                  <p className="text-sm text-text-muted">
                    Give this skill a clear name, choose who can use it, and decide where it should
                    live.
                  </p>
                </section>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div className="space-y-2">
                    <Label htmlFor="skill-scope">Who can use it</Label>
                    <Select
                      value={scope}
                      onValueChange={(value) => setScope(value as 'user' | 'project')}
                      disabled={mode === 'edit'}
                    >
                      <SelectTrigger id="skill-scope">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">User</SelectItem>
                        <SelectItem value="project" disabled={!canUseProjectScope}>
                          {canUseProjectScope
                            ? `Project: ${projectLabel ?? projectPath}`
                            : 'Project unavailable'}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="skill-root">Where to store it</Label>
                    <Select
                      value={rootKind}
                      onValueChange={(value) =>
                        setRootKind(value as 'claude' | 'cursor' | 'agents')
                      }
                      disabled={mode === 'edit'}
                    >
                      <SelectTrigger id="skill-root">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="claude">.claude</SelectItem>
                        <SelectItem value="cursor">.cursor</SelectItem>
                        <SelectItem value="agents">.agents</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="skill-folder">Folder name</Label>
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
                        We suggest this automatically from the skill name so review works right
                        away.
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="skill-invocation">How Claude should use it</Label>
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
                        <SelectItem value="auto">Claude can use it automatically</SelectItem>
                        <SelectItem value="manual-only">Only when you ask for it</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="skill-name">Skill name</Label>
                    <Input
                      id="skill-name"
                      value={name}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setName(nextValue);
                        if (mode === 'create' && !folderNameEdited) {
                          setFolderName(toSuggestedFolderName(nextValue || 'New Skill'));
                        }
                        applyFormToRawContent({ name: nextValue });
                      }}
                      placeholder="Write concise skill name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="skill-license">License</Label>
                    <Input
                      id="skill-license"
                      value={license}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setLicense(nextValue);
                        applyFormToRawContent({ license: nextValue });
                      }}
                      placeholder="MIT"
                    />
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="skill-description">Description</Label>
                    <Input
                      id="skill-description"
                      value={description}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setDescription(nextValue);
                        applyFormToRawContent({ description: nextValue });
                      }}
                      placeholder="What this skill helps with"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="skill-compatibility">Compatibility</Label>
                    <Input
                      id="skill-compatibility"
                      value={compatibility}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setCompatibility(nextValue);
                        applyFormToRawContent({ compatibility: nextValue });
                      }}
                      placeholder="claude-code, cursor"
                    />
                  </div>
                </div>

                {!customMarkdownDetected && (
                  <>
                    <section className="space-y-1">
                      <h3 className="text-sm font-semibold text-text">2. Instructions</h3>
                      <p className="text-sm text-text-muted">
                        These sections generate the skill file for you, so you do not need to edit
                        markdown unless you want to.
                      </p>
                    </section>

                    <div className="grid gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="skill-when-to-use">When Claude should reach for this</Label>
                        <Textarea
                          id="skill-when-to-use"
                          value={whenToUse}
                          disabled={instructionsLocked}
                          onChange={(event) => {
                            const nextValue = event.target.value;
                            setWhenToUse(nextValue);
                            applyFormToRawContent({ whenToUse: nextValue });
                          }}
                          placeholder="Example: Use this when the task is a code review or bug triage request."
                          className="min-h-[88px]"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="skill-steps">Main steps Claude should follow</Label>
                        <Textarea
                          id="skill-steps"
                          value={steps}
                          disabled={instructionsLocked}
                          onChange={(event) => {
                            const nextValue = event.target.value;
                            setSteps(nextValue);
                            applyFormToRawContent({ steps: nextValue });
                          }}
                          placeholder={
                            '1. Inspect the relevant files.\n2. Explain the main risk first.\n3. Suggest the safest fix.'
                          }
                          className="min-h-[120px]"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="skill-notes">Extra notes or guardrails</Label>
                        <Textarea
                          id="skill-notes"
                          value={notes}
                          disabled={instructionsLocked}
                          onChange={(event) => {
                            const nextValue = event.target.value;
                            setNotes(nextValue);
                            applyFormToRawContent({ notes: nextValue });
                          }}
                          placeholder="Example: Call out missing tests, regressions, and risky assumptions."
                          className="min-h-[88px]"
                        />
                        {instructionsLocked && (
                          <p className="text-xs text-text-muted">
                            Structured fields are locked because you switched to manual `SKILL.md`
                            editing below.
                          </p>
                        )}
                      </div>
                    </div>
                  </>
                )}

                <section className="space-y-1">
                  <h3 className="text-sm font-semibold text-text">3. Extra files</h3>
                  <p className="text-sm text-text-muted">
                    Add supporting docs, scripts, or assets only if this skill really needs them.
                  </p>
                </section>

                <div className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-text">Optional files</p>
                      <p className="mt-1 text-xs text-text-muted">
                        Add starter files that will be included in the review and written together
                        with `SKILL.md`.
                      </p>
                    </div>
                    {mode === 'edit' && (
                      <Badge variant="outline" className="font-normal">
                        Root and folder are locked for edits
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
                        <p className="font-medium text-text">References</p>
                        <p className="mt-1 text-xs text-text-muted">
                          Add supporting docs, links, or examples that Claude can look at.
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
                        <p className="font-medium text-text">Scripts</p>
                        <p className="mt-1 text-xs text-text-muted">
                          Add helper commands or setup notes. Review carefully before sharing this
                          skill.
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
                        <p className="font-medium text-text">Assets</p>
                        <p className="mt-1 text-xs text-text-muted">
                          Add screenshots or bundled media only if they help explain the workflow.
                        </p>
                      </div>
                    </label>
                  </div>

                  {auxiliaryDraftFilePaths.length > 0 && (
                    <div className="mt-4">
                      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                        Added files:
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
                          ? '2. SKILL.md editor'
                          : '4. Advanced SKILL.md editor'}
                      </h3>
                      <p className="text-sm text-text-muted">
                        {customMarkdownDetected
                          ? 'This skill uses a custom markdown format, so edit it directly here.'
                          : 'Most people can skip this. Open it only if you want direct control over the raw markdown file.'}
                      </p>
                    </div>
                    {!customMarkdownDetected && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowAdvancedEditor((prev) => !prev)}
                      >
                        {showAdvancedEditor ? 'Hide Advanced Editor' : 'Show Advanced Editor'}
                      </Button>
                    )}
                  </div>

                  {showAdvancedEditor && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="skill-raw">SKILL.md</Label>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setManualRawEdit(false);
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
                          Reset From Structured Fields
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
                Cancel
              </Button>
              <div className="min-w-[16rem] flex-1">
                <p className="text-sm text-text-muted">
                  Review the file changes first, then confirm save in the next step.
                </p>
                {mutationError && <p className="mt-1 text-sm text-red-400">{mutationError}</p>}
              </div>
              <Button onClick={() => void handleReview()} disabled={reviewLoading || saveLoading}>
                <FileSearch className="mr-1.5 size-3.5" />
                {reviewLoading
                  ? 'Preparing...'
                  : mode === 'create'
                    ? 'Review And Create'
                    : 'Review And Save'}
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
        confirmLabel={mode === 'create' ? 'Create Skill' : 'Save Skill'}
        reviewLabel={mode === 'create' ? 'Creating a skill' : 'Saving this skill'}
      />
    </>
  );
};
