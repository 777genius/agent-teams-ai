import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { SearchInput } from '@renderer/components/extensions/common/SearchInput';
import { SkillImportDialog } from '@renderer/components/extensions/skills/SkillImportDialog';
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
import { Download, Loader2, RefreshCw } from 'lucide-react';

import { ManagedInstallationState } from './ManagedInstallationState';
import { ManagedSkillSourcePreview } from './ManagedSkillSourcePreview';
import { ManagementInstallationTargets } from './ManagementInstallationTargets';
import { ManagementOperationView } from './ManagementOperationView';
import { ManagementPlanDialog } from './ManagementPlanDialog';
import { ManagementRestorePoint } from './ManagementRestorePoint';

import type { ExtensionClient, SkillCopyCandidate } from '../../contracts';
import type { ManagedExtensionsModel } from '../hooks/useManagedExtensions';

interface Props {
  kind: 'plugin' | 'skill';
  model: ManagedExtensionsModel;
}
export const ManagedExtensionsPanel = ({ kind, model }: Props) => {
  const { t } = useAppTranslation('extensions');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [source, setSource] = useState('');
  const [revision, setRevision] = useState('');
  const [alias, setAlias] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([]);
  const [copySource, setCopySource] = useState<SkillCopyCandidate | null>(null);
  const { copyCandidates, setCopyCandidates } = model;
  useEffect(() => {
    if (copyCandidates?.length === 1) {
      setCopySource(copyCandidates[0]);
      setCopyCandidates(null);
    }
  }, [copyCandidates, setCopyCandidates]);
  useEffect(() => {
    setSelected([]);
    setSelectedCandidates([]);
    setSourceOpen(false);
  }, [model.context?.contextId, model.client]);
  if (!model.available) return null;
  const pending = Boolean(model.environment?.pendingOperations?.length) || model.reviewUncertain;
  const disabled = model.busy || model.isRunning || !model.context || pending;
  const capability = (action: string) =>
    model.context?.session.capabilities.find((item) => item.action === action);
  const actionDisabled = (action: string) =>
    disabled ||
    capability(action)?.supported !== true ||
    ((action === 'install' || action === 'install_skills') && !model.installationTargetIds.length);
  const installationTargets = (
    <ManagementInstallationTargets
      targets={model.installationTargets}
      disabled={disabled || Boolean(model.plan)}
      onSelect={model.selectInstallationTarget}
    />
  );
  const changeSource = (value: string) => {
    setSource(value);
    void model.closeDiscovery();
    setSelectedCandidates([]);
  };
  const selectedUpdatable = selected.filter((alias) =>
    model.installed.some(
      (entry) =>
        entry.alias === alias &&
        entry.declared &&
        entry.updateStatus !== 'pinned' &&
        entry.updateStatus !== 'blocked'
    )
  );
  return (
    <section
      className="mb-6 space-y-4 rounded-xl border border-border p-4"
      data-testid={`uap-${kind}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-text">
            {t(kind === 'skill' ? 'uap.skillsTitle' : 'uap.pluginsTitle')}
          </h2>
          <p className="text-xs text-text-muted">{t('uap.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={model.client}
            disabled={model.busy || model.reviewUncertain}
            onValueChange={(value) => model.setClient(value as ExtensionClient)}
          >
            <SelectTrigger className="w-36" aria-label={t('uap.agent')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="claude">Claude Code</SelectItem>
              <SelectItem value="codex">Codex</SelectItem>
              <SelectItem value="opencode">OpenCode</SelectItem>
            </SelectContent>
          </Select>
          <Badge variant="outline">{t('uap.userScope')}</Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void model.reload()}
            disabled={model.busy}
            aria-label={t('uap.refresh')}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>
      <p className="text-xs text-text-muted">{t('uap.projectPending')}</p>
      {model.error && (
        <div
          role="alert"
          className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400"
        >
          {model.error}
        </div>
      )}
      {model.operation && (
        <ManagementOperationView
          operation={model.operation}
          busy={model.busy}
          onCancel={() => void model.cancel()}
          onRecover={() => void model.recover()}
        />
      )}
      {pending && <p className="text-xs text-amber-400">{t('uap.pendingChanges')}</p>}
      {installationTargets}
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-40 flex-1">
          <SearchInput
            value={model.query}
            onChange={model.setQuery}
            placeholder={t('uap.search')}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setSourceOpen(true)}
          disabled={actionDisabled(kind === 'skill' ? 'install_skills' : 'install')}
        >
          <Download className="mr-2 size-4" />
          {t('uap.fromSource')}
        </Button>
      </div>
      {model.busy && (
        <p className="flex items-center gap-2 text-sm text-text-muted" role="status">
          <Loader2 className="size-4 animate-spin" />
          {t('uap.working')}
        </p>
      )}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t('uap.installed')}</h3>
          <div className="flex flex-wrap gap-2">
            {selectedUpdatable.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={actionDisabled('update')}
                onClick={() => void model.prepare({ action: 'update', aliases: selectedUpdatable })}
              >
                {t('uap.updateSelected', { count: selectedUpdatable.length })}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={
                actionDisabled('update') ||
                !model.environment?.entries.some((entry) => entry.declared)
              }
              onClick={() => void model.prepare({ action: 'update', all: true })}
            >
              {t('uap.updateAll')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={actionDisabled('sync')}
              onClick={() => void model.prepare({ action: 'sync' })}
            >
              {t('uap.restore')}
            </Button>
          </div>
        </div>
        {Boolean(model.environment?.entries.length) && (
          <p className="text-xs text-text-muted">{t('uap.environmentActions')}</p>
        )}
        {!model.busy && !model.installed.length && (
          <p className="text-sm text-text-muted">{t('uap.noInstalled')}</p>
        )}
        {model.installed.map((entry) => (
          <div
            key={entry.alias}
            className="flex flex-wrap items-start gap-3 rounded-lg border border-border p-3"
            data-testid="uap-installed-entry"
          >
            <Checkbox
              aria-label={t('uap.selectEntry', { name: entry.alias })}
              disabled={
                actionDisabled('update') ||
                !entry.declared ||
                entry.updateStatus === 'pinned' ||
                entry.updateStatus === 'blocked'
              }
              checked={selected.includes(entry.alias)}
              onCheckedChange={(checked) =>
                setSelected((values) =>
                  checked
                    ? [...values, entry.alias]
                    : values.filter((value) => value !== entry.alias)
                )
              }
            />
            <div className="min-w-40 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{entry.alias}</span>
                <Badge variant="outline">UAP</Badge>
                {entry.version && <span className="text-xs text-text-muted">{entry.version}</span>}
              </div>
              <ManagedInstallationState entry={entry} targets={model.context?.session.targets} />
              {!entry.declared && (
                <p className="text-xs text-text-muted">{t('uap.transitiveDependency')}</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={model.busy}
                onClick={() => void model.loadCopySources(entry.alias)}
              >
                {t('uap.copyLocal')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  actionDisabled('update') ||
                  !entry.declared ||
                  entry.updateStatus === 'pinned' ||
                  entry.updateStatus === 'blocked'
                }
                onClick={() => void model.prepare({ action: 'update', aliases: [entry.alias] })}
              >
                {t('uap.update')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={actionDisabled('repair') || !entry.declared}
                onClick={() => void model.prepare({ action: 'repair', aliases: [entry.alias] })}
              >
                {t('uap.repair')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={actionDisabled('remove') || !entry.declared}
                onClick={() => void model.prepare({ action: 'remove', aliases: [entry.alias] })}
              >
                {t('uap.remove')}
              </Button>
            </div>
          </div>
        ))}
      </div>
      {model.environment?.diagnostics.map((item, index) => (
        <p key={`${item.code}-${index}`} className="text-xs text-amber-400">
          {item.message}
        </p>
      ))}
      {kind === 'skill' && Boolean(model.environment?.localSkillBackups?.length) && (
        <details className="rounded-lg border border-border p-3" data-testid="uap-restore-points">
          <summary className="cursor-pointer text-sm font-medium">{t('uap.restorePoints')}</summary>
          <p className="my-2 text-xs text-text-muted">{t('uap.restoreRetention')}</p>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {model.environment?.localSkillBackups?.map((backup) => (
              <div
                key={backup.operationId}
                className="flex flex-wrap items-center justify-between gap-2"
                data-testid="uap-restore-point"
                data-restore-operation-id={backup.operationId}
                data-original-action={backup.originalAction}
              >
                <ManagementRestorePoint backup={backup} />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    void model.restoreLocal(backup.rootId, backup.skillName, backup.operationId)
                  }
                >
                  {t('uap.restoreFiles')}
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}
      {kind === 'plugin' && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">{t('uap.catalog')}</h3>
          {model.catalogLoading && <p className="text-xs text-text-muted">{t('uap.working')}</p>}
          {model.catalogError && (
            <p className="text-xs text-amber-400">
              {t('uap.catalogUnavailable')} {model.catalogError}
            </p>
          )}
          {model.catalog?.freshness !== 'current' && model.catalog && (
            <p className="text-xs text-text-muted">{t('uap.catalogUnavailable')}</p>
          )}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {model.items.map((entry) => (
              <article
                key={entry.id}
                data-catalog-id={entry.id}
                className="space-y-2 rounded-lg border border-border p-3"
              >
                <Button
                  variant="link"
                  className="h-auto p-0 text-left font-medium"
                  disabled={model.busy}
                  onClick={() => void model.showDetail(entry.id)}
                >
                  {entry.name}
                </Button>
                <p className="text-xs text-text-secondary">{entry.description}</p>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-text-muted">{entry.targets.join(', ')}</span>
                  <Button
                    size="sm"
                    disabled={
                      actionDisabled('install') ||
                      !entry.available ||
                      model.installationTargets.some(
                        (target) => target.selected && !entry.targets.includes(target.client)
                      )
                    }
                    onClick={() => void model.prepare({ action: 'install' }, entry.id)}
                  >
                    {t('uap.install')}
                  </Button>
                </div>
                {!entry.available && <p className="text-xs text-amber-400">{entry.reason}</p>}
                {entry.available &&
                  model.installationTargets.some(
                    (target) => target.selected && !entry.targets.includes(target.client)
                  ) && (
                    <p className="text-xs text-amber-400">
                      {t('uap.incompatibleInstallTargets', {
                        names: model.installationTargets
                          .filter(
                            (target) => target.selected && !entry.targets.includes(target.client)
                          )
                          .map((target) => target.label)
                          .join(', '),
                      })}
                    </p>
                  )}
              </article>
            ))}
          </div>
        </div>
      )}
      <Dialog
        open={sourceOpen}
        onOpenChange={(open) => {
          if (!open && model.preview) {
            model.setPreview(null);
            return;
          }
          setSourceOpen(open);
          if (!open) void model.closeDiscovery();
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          {model.preview ? (
            <ManagedSkillSourcePreview
              preview={model.preview}
              candidates={model.candidates}
              onBack={() => model.setPreview(null)}
            />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t('uap.fromSource')}</DialogTitle>
                <DialogDescription>
                  {t(kind === 'plugin' ? 'uap.pluginSourceHelp' : 'uap.sourceHelp')}
                </DialogDescription>
              </DialogHeader>
              {installationTargets}
              <Label htmlFor={`uap-source-${kind}`}>{t('uap.source')}</Label>
              <Input
                id={`uap-source-${kind}`}
                value={source}
                onChange={(event) => changeSource(event.target.value)}
                placeholder={
                  kind === 'plugin'
                    ? 'owner/repository@v1.2.3'
                    : 'https://github.com/owner/repository'
                }
              />
              {kind === 'skill' && (
                <>
                  <Label htmlFor="uap-ref-skill">{t('uap.revision')}</Label>
                  <Input
                    id="uap-ref-skill"
                    value={revision}
                    onChange={(event) => {
                      setRevision(event.target.value);
                      void model.closeDiscovery();
                      setSelectedCandidates([]);
                    }}
                  />
                </>
              )}
              {kind === 'plugin' && (
                <>
                  <Label htmlFor="uap-alias">{t('uap.alias')}</Label>
                  <Input
                    id="uap-alias"
                    value={alias}
                    onChange={(event) => setAlias(event.target.value)}
                  />
                </>
              )}
              {model.error && (
                <p role="alert" className="text-sm text-red-400">
                  {model.error}
                </p>
              )}
              {kind === 'skill' && (
                <Button
                  disabled={disabled || !source.trim()}
                  onClick={() => {
                    setSelectedCandidates([]);
                    void model.discover(source.trim(), revision.trim() || undefined);
                  }}
                >
                  {t('uap.findSkills')}
                </Button>
              )}
              {model.candidates && (
                <div className="space-y-3">
                  {model.candidates.diagnostics.map((item, index) => (
                    <p key={index} className="text-xs text-amber-400">
                      {item.message}
                    </p>
                  ))}
                  {model.candidates.candidates.map((candidate) => (
                    <div
                      key={candidate.id}
                      className="flex items-start gap-3 rounded-md border border-border p-3"
                    >
                      <Checkbox
                        aria-label={candidate.name}
                        checked={selectedCandidates.includes(candidate.id)}
                        disabled={!candidate.available}
                        onCheckedChange={(checked) =>
                          setSelectedCandidates((values) =>
                            checked
                              ? [...values, candidate.id]
                              : values.filter((value) => value !== candidate.id)
                          )
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{candidate.name}</span>
                        <span className="block text-xs text-text-muted">
                          {candidate.description}
                        </span>
                        {!candidate.available && (
                          <span className="block text-xs text-amber-400">{candidate.reason}</span>
                        )}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={model.busy}
                        onClick={() => void model.previewSkill(candidate.id)}
                      >
                        {t('uap.preview')}
                      </Button>
                    </div>
                  ))}
                  <Button
                    disabled={actionDisabled('install_skills') || !selectedCandidates.length}
                    onClick={async () => {
                      const reviewed = await model.prepare({
                        action: 'install_skills',
                        catalogId: model.candidates!.catalogId,
                        candidateIds: selectedCandidates,
                      });
                      if (reviewed) {
                        setSourceOpen(false);
                        await model.closeDiscovery();
                      }
                    }}
                  >
                    {t('uap.reviewInstall')}
                  </Button>
                </div>
              )}
              {kind === 'plugin' && (
                <Button
                  disabled={actionDisabled('install') || !source.trim()}
                  onClick={async () => {
                    const reviewed = await model.prepare({
                      action: 'install',
                      source: source.trim(),
                      ...(alias.trim() ? { alias: alias.trim() } : {}),
                    });
                    if (reviewed) setSourceOpen(false);
                  }}
                >
                  {t('uap.reviewInstall')}
                </Button>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      <ManagementPlanDialog
        plan={model.plan}
        targets={model.context?.session.targets}
        busy={model.busy}
        error={model.error}
        uncertain={model.reviewUncertain}
        onClose={() => void model.closeReview()}
        onApply={() => void model.apply()}
        onAttestExternalUninstall={
          model.canAttestExternalUninstall ? () => void model.attestExternalUninstall() : undefined
        }
      />
      <Dialog
        open={Boolean(model.copyCandidates?.length)}
        onOpenChange={(open) => !open && model.setCopyCandidates(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('uap.copyLocal')}</DialogTitle>
            <DialogDescription>{t('uap.chooseCopySkill')}</DialogDescription>
          </DialogHeader>
          {model.copyCandidates?.map((candidate) => (
            <Button
              key={candidate.sourceDir}
              variant="outline"
              onClick={() => {
                setCopySource(candidate);
                model.setCopyCandidates(null);
              }}
            >
              {candidate.skillName}
            </Button>
          ))}
        </DialogContent>
      </Dialog>
      {copySource && (
        <SkillImportDialog
          open={true}
          projectPath={null}
          projectLabel={null}
          allowCodexRootKind={model.client === 'codex'}
          initialSourceDir={copySource.sourceDir}
          initialFolderName={`${copySource.skillName}-copy`}
          sourceLocked
          operations={{
            previewImport: (request) => model.previewCopy(copySource.id, request),
            applyImport: async (request) => {
              setCopySource(null);
              return model.applyCopy(request);
            },
          }}
          onClose={() => {
            setCopySource(null);
            void model.closeCopyReview().catch(() => {});
          }}
          onImported={() => {}}
        />
      )}
      <Dialog
        open={Boolean(model.entryDetail)}
        onOpenChange={(open) => !open && model.setEntryDetail(null)}
      >
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{model.entryDetail?.name}</DialogTitle>
            <DialogDescription>{model.entryDetail?.description}</DialogDescription>
          </DialogHeader>
          <p className="text-xs text-text-muted">{model.entryDetail?.targets.join(', ')}</p>
          {model.entryDetail?.readmeMarkdown && (
            <MarkdownViewer content={model.entryDetail.readmeMarkdown} bare />
          )}
          {model.entryDetail?.reason && (
            <p className="text-sm text-amber-400">{model.entryDetail.reason}</p>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
};
