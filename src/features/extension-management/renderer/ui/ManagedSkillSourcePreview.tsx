import { useAppTranslation } from '@features/localization/renderer';
import { CodeBlockViewer } from '@renderer/components/chat/viewers/CodeBlockViewer';
import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { Button } from '@renderer/components/ui/button';
import { DialogDescription, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog';
import { splitSkillFrontmatter } from '@shared/utils/skillFrontmatter';

import type { SkillCandidates, SkillPreview } from '../../contracts';

export const ManagedSkillSourcePreview = ({
  preview,
  candidates,
  onBack,
}: {
  preview: SkillPreview;
  candidates: SkillCandidates | null;
  onBack(): void;
}) => {
  const { t } = useAppTranslation('extensions');
  const candidate = candidates?.candidates.find((item) => item.id === preview.candidateId);
  const { body } = splitSkillFrontmatter(preview.markdown);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{candidate?.name || t('uap.preview')}</DialogTitle>
        <DialogDescription>{candidate?.description || t('uap.preview')}</DialogDescription>
      </DialogHeader>
      {preview.diagnostics.map((item, index) => (
        <p key={index} className="text-xs text-amber-400">
          {item.message}
        </p>
      ))}
      <MarkdownViewer content={body} bare />
      <details className="rounded-md border border-border p-3 text-sm">
        <summary className="cursor-pointer font-medium">
          {t('skillDetail.files.advancedDetails')}
        </summary>
        <CodeBlockViewer fileName="SKILL.md" content={preview.markdown} maxHeight="max-h-72" />
      </details>
      <Button variant="outline" onClick={onBack}>
        {t('uap.backToSource')}
      </Button>
    </>
  );
};
