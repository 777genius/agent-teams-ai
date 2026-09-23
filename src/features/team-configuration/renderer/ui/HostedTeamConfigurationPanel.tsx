import { useCallback, useEffect, useRef, useState } from 'react';

import { getHostedCsrfToken } from '@features/hosted-access/renderer';
import { TEAM_LIFECYCLE_READ_SCHEMA_VERSION } from '@features/team-lifecycle/contracts';
import { createHostedTeamLifecycleTransport } from '@features/team-lifecycle/renderer';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@renderer/components/ui/alert-dialog';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { Textarea } from '@renderer/components/ui/textarea';

import {
  HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
  type HostedSavedTeamRequest,
  type HostedTeamConfigurationIdempotencyKey,
  parseHostedTeamConfigurationIdempotencyKey,
} from '../../contracts/hosted';
import {
  HOSTED_MVP_TOOL_APPROVAL_MODE,
  type HostedRosterConfiguration,
} from '../../contracts/hostedRosterConfiguration';
import {
  buildHostedRosterConfiguration,
  createHostedInitialRosterDraft,
  hostedConfigurationToRosterDraft,
  type HostedInitialRosterDraft,
  hostedRosterCreateFingerprint,
} from '../view-models/hostedInitialRoster';

import { HostedInitialRosterEditor } from './HostedInitialRosterEditor';

import type { HostedTeamConfigurationTransport } from '../ports/HostedTeamConfigurationRendererPorts';
import type { TeamLifecycleReadTransportApi } from '@features/team-lifecycle/contracts';
import type { Cursor, Revision, TeamId, WorkspaceId } from '@shared/contracts/hosted';

export interface HostedTeamConfigurationPanelProps {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId | null;
  readonly transport: HostedTeamConfigurationTransport;
  readonly onTeamCreated: (teamId: TeamId) => void;
  readonly onTeamDeleted: (teamId: TeamId) => void;
  readonly createIdempotencyKey?: () => HostedTeamConfigurationIdempotencyKey;
  readonly lifecycleTransport?: Pick<TeamLifecycleReadTransportApi, 'listTeamLifecycle'>;
}

type Feedback = Readonly<{ tone: 'error' | 'status'; text: string }> | null;

let fallbackKeySequence = 0;

function defaultIdempotencyKey(): HostedTeamConfigurationIdempotencyKey {
  const suffix =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `fallback-${Date.now()}-${++fallbackKeySequence}`;
  return parseHostedTeamConfigurationIdempotencyKey(
    `idempotency_team-configuration-renderer-${suffix}`
  );
}

function errorText(code: string): string {
  if (code === 'conflict') return 'This draft changed on the server. Reload it before retrying.';
  if (code === 'not_found') return 'This draft is no longer available.';
  if (code === 'unsupported') return 'Manual approval is temporarily unavailable in Hosted MVP.';
  if (code === 'cancelled') return 'The request was cancelled.';
  return 'The team configuration request could not be completed.';
}

const defaultLifecycleTransport = createHostedTeamLifecycleTransport({
  fetch: (input, init) => fetch(input, init),
  getCsrfToken: getHostedCsrfToken,
});

async function isUnpromotedDraft(
  transport: Pick<TeamLifecycleReadTransportApi, 'listTeamLifecycle'>,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  signal: AbortSignal
): Promise<boolean> {
  let cursor: Cursor | null = null;
  let expectedRevision: Revision | null = null;
  const seenCursors = new Set<string>();
  try {
    for (let page = 0; page < 32 && !signal.aborted; page += 1) {
      const result = await transport.listTeamLifecycle({
        schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
        cursor,
        expectedRevision,
      });
      if (signal.aborted || result.kind !== 'success') return false;
      if (expectedRevision !== null && result.snapshotRevision !== expectedRevision) return false;
      expectedRevision = result.snapshotRevision;
      const item = result.items.find((candidate) => candidate.teamId === teamId);
      if (item) return item.workspaceId === workspaceId && item.lifecycle === 'draft';
      if (result.nextCursor === null || seenCursors.has(result.nextCursor)) return false;
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
  } catch {
    // An unverified lifecycle state must never unlock a saved roster.
  }
  return false;
}

export const HostedTeamConfigurationPanel = ({
  workspaceId,
  teamId,
  transport,
  onTeamCreated,
  onTeamDeleted,
  createIdempotencyKey = defaultIdempotencyKey,
  lifecycleTransport = defaultLifecycleTransport,
}: HostedTeamConfigurationPanelProps): React.JSX.Element => {
  const identityKey = `${workspaceId}:${teamId ?? 'create'}`;
  const latestIdentityKey = useRef(identityKey);
  latestIdentityKey.current = identityKey;
  const operation = useRef<AbortController | null>(null);
  const createIntent = useRef<{
    readonly fingerprint: string;
    readonly key: HostedTeamConfigurationIdempotencyKey;
  } | null>(null);
  const [draft, setDraft] = useState<HostedSavedTeamRequest | null>(null);
  const [name, setName] = useState('');
  const [roster, setRoster] = useState<HostedInitialRosterDraft>(createHostedInitialRosterDraft);
  const [rosterErrors, setRosterErrors] = useState<readonly string[]>([]);
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('');
  const [language, setLanguage] = useState('');
  const [busy, setBusy] = useState(false);
  const [canEditDraft, setCanEditDraft] = useState(false);
  const [canDiscardDraft, setCanDiscardDraft] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const applyDraft = useCallback((value: HostedSavedTeamRequest): void => {
    setDraft(value);
    setName(value.metadata.name);
    if (value.configuration) setRoster(hostedConfigurationToRosterDraft(value.configuration));
    setRosterErrors([]);
    setDescription(value.metadata.description ?? '');
    setColor(value.metadata.color ?? '');
    setLanguage(value.metadata.language ?? '');
  }, []);

  const load = useCallback((): void => {
    if (teamId === null) return;
    operation.current?.abort();
    const controller = new AbortController();
    const requestIdentity = identityKey;
    operation.current = controller;
    setBusy(true);
    setCanEditDraft(false);
    setCanDiscardDraft(false);
    setFeedback({ tone: 'status', text: 'Loading team configuration…' });
    void transport
      .getSavedRequest(
        { schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION, workspaceId, teamId },
        { signal: controller.signal }
      )
      .then(async (result) => {
        if (controller.signal.aborted || latestIdentityKey.current !== requestIdentity) return;
        if (result.kind === 'found') {
          applyDraft(result.draft);
          const approvalMode = result.draft.configuration?.toolApprovalMode;
          if (approvalMode !== 'manual') {
            const editable = await isUnpromotedDraft(
              lifecycleTransport,
              workspaceId,
              teamId,
              controller.signal
            );
            if (controller.signal.aborted || latestIdentityKey.current !== requestIdentity) return;
            setCanEditDraft(editable && approvalMode === 'auto');
            setCanDiscardDraft(editable);
            setFeedback(
              approvalMode !== 'auto' || editable
                ? null
                : {
                    tone: 'status',
                    text: 'This roster is read-only because the team is promoted or its draft state could not be verified.',
                  }
            );
          } else {
            setFeedback(null);
          }
        } else {
          setDraft(null);
          setFeedback({ tone: 'error', text: errorText(result.error.code) });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && latestIdentityKey.current === requestIdentity) {
          setBusy(false);
        }
      });
  }, [applyDraft, identityKey, lifecycleTransport, teamId, transport, workspaceId]);

  useEffect(() => {
    operation.current?.abort();
    createIntent.current = null;
    setBusy(false);
    setCanEditDraft(false);
    setCanDiscardDraft(false);
    setFeedback(null);
    setDraft(null);
    setName('');
    setRoster(createHostedInitialRosterDraft());
    setRosterErrors([]);
    setDescription('');
    setColor('');
    setLanguage('');
    if (teamId === null) {
      return;
    }
    load();
    return () => operation.current?.abort();
  }, [identityKey, load, teamId]);

  const createDraft = (): void => {
    const rosterResult = buildHostedRosterConfiguration(roster);
    if (!rosterResult.ok) {
      setRosterErrors(rosterResult.errors);
      setFeedback({
        tone: 'error',
        text: 'Complete the initial roster before creating the draft.',
      });
      return;
    }
    setRosterErrors([]);
    const normalizedName = name.trim();
    const fingerprint = hostedRosterCreateFingerprint(normalizedName, rosterResult.configuration);
    const intent =
      createIntent.current?.fingerprint === fingerprint
        ? createIntent.current
        : { fingerprint, key: createIdempotencyKey() };
    createIntent.current = intent;
    operation.current?.abort();
    const controller = new AbortController();
    const requestIdentity = identityKey;
    operation.current = controller;
    setBusy(true);
    setFeedback({ tone: 'status', text: 'Creating draft…' });
    void transport
      .createDraft(
        {
          schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
          workspaceId,
          idempotencyKey: intent.key,
          name: normalizedName,
          members: rosterResult.members,
          configuration: rosterResult.configuration,
        },
        { signal: controller.signal }
      )
      .then((result) => {
        if (controller.signal.aborted || latestIdentityKey.current !== requestIdentity) return;
        if (result.kind === 'created') {
          createIntent.current = null;
          setFeedback({
            tone: 'status',
            text:
              result.outcome === 'idempotent_replay'
                ? 'Draft recovered from the original create request.'
                : 'Draft created.',
          });
          onTeamCreated(result.identity.teamId);
        } else {
          setFeedback({ tone: 'error', text: errorText(result.error.code) });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && latestIdentityKey.current === requestIdentity) {
          setBusy(false);
        }
      });
  };

  const updateDraft = (): void => {
    if (teamId === null || draft === null || !canEditDraft) return;
    const updates: {
      name?: string;
      description?: string;
      color?: string;
      language?: string;
      configuration?: HostedRosterConfiguration;
    } = {};
    const candidates = { name, description, color, language };
    for (const [field, value] of Object.entries(candidates)) {
      const normalized = value.trim();
      if (normalized && normalized !== (draft.metadata[field as keyof typeof candidates] ?? '')) {
        updates[field as keyof typeof candidates] = normalized;
      }
    }
    if (draft.configuration) {
      const rosterResult = buildHostedRosterConfiguration(roster);
      if (!rosterResult.ok) {
        setRosterErrors(rosterResult.errors);
        setFeedback({ tone: 'error', text: 'Complete the initial roster before saving.' });
        return;
      }
      setRosterErrors([]);
      if (JSON.stringify(rosterResult.configuration) !== JSON.stringify(draft.configuration)) {
        updates.configuration = rosterResult.configuration;
      }
    }
    if (Object.keys(updates).length === 0) {
      setFeedback({ tone: 'status', text: 'No configuration changes to save.' });
      return;
    }
    operation.current?.abort();
    const controller = new AbortController();
    const requestIdentity = identityKey;
    operation.current = controller;
    setBusy(true);
    setFeedback({ tone: 'status', text: 'Saving configuration…' });
    void transport
      .updateDraft(
        {
          schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
          workspaceId,
          teamId,
          expectedRevision: draft.revision,
          updates,
        },
        { signal: controller.signal }
      )
      .then((result) => {
        if (controller.signal.aborted || latestIdentityKey.current !== requestIdentity) return;
        if (result.kind === 'updated') {
          applyDraft(result.draft);
          setFeedback({ tone: 'status', text: 'Configuration saved.' });
        } else {
          if (result.error.code === 'conflict' || result.error.code === 'unsupported') {
            setCanEditDraft(false);
            setCanDiscardDraft(false);
          }
          setFeedback({ tone: 'error', text: errorText(result.error.code) });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && latestIdentityKey.current === requestIdentity) {
          setBusy(false);
        }
      });
  };

  const deleteDraft = (): void => {
    if (teamId === null || draft === null || !canDiscardDraft) return;
    operation.current?.abort();
    const controller = new AbortController();
    const requestIdentity = identityKey;
    operation.current = controller;
    setBusy(true);
    setFeedback({ tone: 'status', text: 'Discarding draft…' });
    void transport
      .deleteDraft(
        {
          schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
          workspaceId,
          teamId,
          expectedRevision: draft.revision,
        },
        { signal: controller.signal }
      )
      .then((result) => {
        if (controller.signal.aborted || latestIdentityKey.current !== requestIdentity) return;
        if (result.kind === 'deleted') {
          setDraft(null);
          setCanEditDraft(false);
          setCanDiscardDraft(false);
          setFeedback({ tone: 'status', text: 'Draft discarded.' });
          onTeamDeleted(teamId);
        } else {
          if (result.error.code === 'conflict' || result.error.code === 'unsupported') {
            setCanDiscardDraft(false);
          }
          setFeedback({ tone: 'error', text: errorText(result.error.code) });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && latestIdentityKey.current === requestIdentity) {
          setBusy(false);
        }
      });
  };

  const editing = teamId !== null;
  const savedReadOnly = editing && !canEditDraft;
  return (
    <section aria-labelledby="hosted-team-configuration-title" className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="hosted-team-configuration-title" className="text-base font-semibold">
          {editing ? 'Team configuration' : 'Create team draft'}
        </h2>
        {editing ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={load}>
            Reload
          </Button>
        ) : null}
      </div>

      <p className="text-sm text-[var(--color-text-muted)]">
        Hosted MVP launches use {HOSTED_MVP_TOOL_APPROVAL_MODE} tool approval. Manual approval is
        temporarily unavailable; saved manual-mode drafts remain readable but cannot be activated.
      </p>

      {draft?.configuration?.toolApprovalMode === 'manual' ? (
        <p role="alert" className="text-sm">
          This saved draft uses manual approval. It remains readable and unchanged, but updates and
          activation are unavailable in Hosted MVP.
        </p>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="hosted-team-name">Name</Label>
        <Input
          id="hosted-team-name"
          aria-label="Team name"
          value={name}
          maxLength={128}
          disabled={busy || (editing && savedReadOnly)}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      {editing ? (
        draft?.configuration ? (
          <HostedInitialRosterEditor
            value={roster}
            readOnly={savedReadOnly}
            onChange={(value) => {
              setRoster(value);
              setRosterErrors([]);
            }}
            disabled={busy}
            errors={rosterErrors}
          />
        ) : draft ? (
          <div role="alert" className="space-y-1 text-sm">
            <p>
              Initial roster configuration is missing. This historical names-only draft remains
              readable but is incomplete and cannot be launched.
            </p>
            <p>Saved member order: {draft.members.map((member) => member.name).join(', ')}</p>
          </div>
        ) : null
      ) : (
        <HostedInitialRosterEditor
          value={roster}
          onChange={(value) => {
            setRoster(value);
            setRosterErrors([]);
          }}
          disabled={busy}
          errors={rosterErrors}
        />
      )}

      {editing ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="hosted-team-description">Description</Label>
            <Textarea
              id="hosted-team-description"
              aria-label="Team description"
              value={description}
              maxLength={4000}
              disabled={busy || savedReadOnly}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="hosted-team-color">Color</Label>
              <Input
                id="hosted-team-color"
                aria-label="Team color"
                value={color}
                maxLength={64}
                disabled={busy || savedReadOnly}
                onChange={(event) => setColor(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hosted-team-language">Language</Label>
              <Input
                id="hosted-team-language"
                aria-label="Team language"
                value={language}
                maxLength={64}
                disabled={busy || savedReadOnly}
                onChange={(event) => setLanguage(event.target.value)}
              />
            </div>
          </div>
          {draft === null ? null : (
            <p className="text-xs text-[var(--color-text-muted)]">
              Server revision: {draft.revision}
            </p>
          )}
        </>
      ) : null}

      {feedback === null ? null : (
        <p role={feedback.tone === 'error' ? 'alert' : 'status'} className="text-sm">
          {feedback.text}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={busy || name.trim().length === 0 || (editing && savedReadOnly)}
          onClick={editing ? updateDraft : createDraft}
        >
          {editing ? 'Save configuration' : 'Create draft'}
        </Button>
        {editing && draft !== null ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="destructive" disabled={busy || !canDiscardDraft}>
                Discard draft
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Discard this draft?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the unconfigured team draft from the selected workspace.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep draft</AlertDialogCancel>
                <AlertDialogAction onClick={deleteDraft}>Discard draft</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
    </section>
  );
};
