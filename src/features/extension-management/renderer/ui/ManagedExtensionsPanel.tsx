import { useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { SearchInput } from '@renderer/components/extensions/common/SearchInput';
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

import { ManagementOperationView } from './ManagementOperationView';
import { ManagementPlanDialog } from './ManagementPlanDialog';

import type { ExtensionClient } from '../../contracts';
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
  useEffect(() => {
    setSelected([]);
    setSelectedCandidates([]);
    setSourceOpen(false);
  }, [model.context?.contextId, model.client]);
  if (!model.available) return null;
  const disabled = model.busy || model.isRunning || !model.context;
  const capability = (action: string) =>
    model.context?.session.capabilities.find((item) => item.action === action);
  const selectedTarget = model.context?.session.targets.find(
    (target) => target.client === model.client
  );
  const actionDisabled = (action: string) =>
    disabled ||
    capability(action)?.supported !== true ||
    ((action === 'install' || action === 'install_skills') && selectedTarget?.available !== true);
  const changeSource = (value: string) => {
    setSource(value);
    model.setCandidates(null);
    model.setPreview(null);
    setSelectedCandidates([]);
  };
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
              <SelectItem value="claude">Claude</SelectItem>
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
          onRecover={() =>
            void model.prepare({ action: 'recover', operationId: model.operation!.operationId })
          }
        />
      )}
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
      {model.context?.session.targets
        .filter((target) => target.client === model.client && !target.available)
        .map((target) => (
          <p key={target.id} className="text-xs text-amber-400">
            {target.reason || t('uap.runtimeUnavailable')}
          </p>
        ))}
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
            {selected.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={actionDisabled('update')}
                onClick={() => void model.prepare({ action: 'update', aliases: selected })}
              >
                {t('uap.updateSelected', { count: selected.length })}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={actionDisabled('update') || !model.environment?.entries.length}
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
        <p className="text-xs text-text-muted">{t('uap.environmentActions')}</p>
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
              <p className="break-all text-xs text-text-muted">{entry.source}</p>
              <p className="text-xs text-text-secondary">
                {t(`uap.updateStatus.${entry.updateStatus}`)}
              </p>
              {entry.bindings.map((binding) => (
                <div key={binding.targetId} className="text-xs text-text-muted">
                  {binding.client}: {binding.status}
                  {binding.readiness && (
                    <span>
                      {' '}
                      ·{' '}
                      {Object.entries(binding.readiness)
                        .map(([name, value]) => `${name}: ${value}`)
                        .join(' · ')}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={actionDisabled('update') || entry.updateStatus === 'pinned'}
                onClick={() => void model.prepare({ action: 'update', aliases: [entry.alias] })}
              >
                {t('uap.update')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={actionDisabled('repair')}
                onClick={() => void model.prepare({ action: 'repair', aliases: [entry.alias] })}
              >
                {t('uap.repair')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={actionDisabled('remove')}
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
      {kind === 'plugin' && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">{t('uap.catalog')}</h3>
          {model.catalog?.freshness !== 'current' && model.catalog && (
            <p className="text-xs text-text-muted">{t('uap.catalogUnavailable')}</p>
          )}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {model.items.map((entry) => (
              <article key={entry.id} className="space-y-2 rounded-lg border border-border p-3">
                <h4 className="text-sm font-medium">{entry.name}</h4>
                <p className="text-xs text-text-secondary">{entry.description}</p>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-text-muted">{entry.targets.join(', ')}</span>
                  <Button
                    size="sm"
                    disabled={
                      actionDisabled('install') ||
                      !entry.available ||
                      !entry.targets.includes(model.client)
                    }
                    onClick={() => void model.prepare({ action: 'install' }, entry.id)}
                  >
                    {t('uap.install')}
                  </Button>
                </div>
                {!entry.available && <p className="text-xs text-amber-400">{entry.reason}</p>}
              </article>
            ))}
          </div>
        </div>
      )}
      <Dialog open={sourceOpen} onOpenChange={setSourceOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('uap.fromSource')}</DialogTitle>
            <DialogDescription>{t('uap.sourceHelp')}</DialogDescription>
          </DialogHeader>
          <Label htmlFor={`uap-source-${kind}`}>{t('uap.source')}</Label>
          <Input
            id={`uap-source-${kind}`}
            value={source}
            onChange={(event) => changeSource(event.target.value)}
            placeholder="https://github.com/owner/repository"
          />
          <Label htmlFor={`uap-ref-${kind}`}>{t('uap.revision')}</Label>
          <Input
            id={`uap-ref-${kind}`}
            value={revision}
            onChange={(event) => {
              setRevision(event.target.value);
              model.setCandidates(null);
              model.setPreview(null);
              setSelectedCandidates([]);
            }}
          />
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
          {kind === 'skill' && !model.candidates && (
            <Button
              disabled={disabled || !source.trim()}
              onClick={() => void model.discover(source.trim(), revision.trim() || undefined)}
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
                    <span className="block text-xs text-text-muted">{candidate.description}</span>
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
                onClick={() => {
                  void model.prepare({
                    action: 'install_skills',
                    catalogId: model.candidates!.catalogId,
                    candidateIds: selectedCandidates,
                  });
                  setSourceOpen(false);
                }}
              >
                {t('uap.reviewInstall')}
              </Button>
            </div>
          )}
          {kind === 'plugin' && (
            <Button
              disabled={actionDisabled('install') || !source.trim()}
              onClick={() => {
                void model.prepare({
                  action: 'install',
                  source: source.trim(),
                  ...(revision.trim() ? { ref: revision.trim() } : {}),
                  ...(alias.trim() ? { alias: alias.trim() } : {}),
                });
                setSourceOpen(false);
              }}
            >
              {t('uap.reviewInstall')}
            </Button>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(model.preview)}
        onOpenChange={(open) => !open && model.setPreview(null)}
      >
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('uap.preview')}</DialogTitle>
            <DialogDescription>
              {
                model.candidates?.candidates.find((item) => item.id === model.preview?.candidateId)
                  ?.name
              }
            </DialogDescription>
          </DialogHeader>
          {model.preview?.diagnostics.map((item, index) => (
            <p key={index} className="text-xs text-amber-400">
              {item.message}
            </p>
          ))}
          {model.preview && <MarkdownViewer content={model.preview.markdown} bare />}
        </DialogContent>
      </Dialog>
      <ManagementPlanDialog
        plan={model.plan}
        busy={model.busy}
        error={model.error}
        uncertain={model.reviewUncertain}
        onClose={() => void model.closeReview()}
        onApply={() => void model.apply()}
      />
    </section>
  );
};
