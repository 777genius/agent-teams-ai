import { useEffect, useRef, useState } from 'react';

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

import type { HostedTeamConfigurationTransport } from '../ports/HostedTeamConfigurationRendererPorts';
import type { TeamId, WorkspaceId } from '@shared/contracts/hosted';

export interface HostedTeamConfigurationPanelProps {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId | null;
  readonly transport: HostedTeamConfigurationTransport;
  readonly onTeamCreated: (teamId: TeamId) => void;
  readonly onTeamDeleted: (teamId: TeamId) => void;
  readonly createIdempotencyKey?: () => HostedTeamConfigurationIdempotencyKey;
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

function memberNames(value: string): readonly { readonly name: string }[] {
  return value
    .split(/[\s,]+/u)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => Object.freeze({ name }));
}

function errorText(code: string): string {
  if (code === 'conflict') return 'This draft changed on the server. Reload it before retrying.';
  if (code === 'not_found') return 'This draft is no longer available.';
  if (code === 'cancelled') return 'The request was cancelled.';
  return 'The team configuration request could not be completed.';
}

export const HostedTeamConfigurationPanel = ({
  workspaceId,
  teamId,
  transport,
  onTeamCreated,
  onTeamDeleted,
  createIdempotencyKey = defaultIdempotencyKey,
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
  const [members, setMembers] = useState('lead');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('');
  const [language, setLanguage] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const applyDraft = (value: HostedSavedTeamRequest): void => {
    setDraft(value);
    setName(value.metadata.name);
    setMembers(value.members.map((member) => member.name).join(', '));
    setDescription(value.metadata.description ?? '');
    setColor(value.metadata.color ?? '');
    setLanguage(value.metadata.language ?? '');
  };

  const load = (): void => {
    if (teamId === null) return;
    operation.current?.abort();
    const controller = new AbortController();
    const requestIdentity = identityKey;
    operation.current = controller;
    setBusy(true);
    setFeedback({ tone: 'status', text: 'Loading team configuration…' });
    void transport
      .getSavedRequest(
        { schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION, workspaceId, teamId },
        { signal: controller.signal }
      )
      .then((result) => {
        if (controller.signal.aborted || latestIdentityKey.current !== requestIdentity) return;
        if (result.kind === 'found') {
          applyDraft(result.draft);
          setFeedback(null);
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
  };

  useEffect(() => {
    operation.current?.abort();
    createIntent.current = null;
    setBusy(false);
    setFeedback(null);
    setDraft(null);
    setName('');
    setMembers('lead');
    setDescription('');
    setColor('');
    setLanguage('');
    if (teamId === null) {
      return;
    }
    load();
    return () => operation.current?.abort();
    // load deliberately captures the current immutable hosted identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey, transport]);

  const createDraft = (): void => {
    const normalizedMembers = memberNames(members);
    const normalizedName = name.trim();
    const fingerprint = JSON.stringify({ name: normalizedName, members: normalizedMembers });
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
          members: normalizedMembers,
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
    if (teamId === null || draft === null) return;
    const updates: Record<string, string> = {};
    const candidates = { name, description, color, language };
    for (const [field, value] of Object.entries(candidates)) {
      const normalized = value.trim();
      if (normalized && normalized !== (draft.metadata[field as keyof typeof candidates] ?? '')) {
        updates[field] = normalized;
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
    if (teamId === null || draft === null) return;
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
          setFeedback({ tone: 'status', text: 'Draft discarded.' });
          onTeamDeleted(teamId);
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

  const editing = teamId !== null;
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

      <div className="space-y-1.5">
        <Label htmlFor="hosted-team-name">Name</Label>
        <Input
          id="hosted-team-name"
          aria-label="Team name"
          value={name}
          maxLength={128}
          disabled={busy || (editing && draft === null)}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      {editing ? null : (
        <div className="space-y-1.5">
          <Label htmlFor="hosted-team-members">Initial member names</Label>
          <Input
            id="hosted-team-members"
            aria-label="Initial member names"
            value={members}
            disabled={busy}
            onChange={(event) => setMembers(event.target.value)}
            placeholder="lead, researcher"
          />
        </div>
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
              disabled={busy || draft === null}
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
                disabled={busy || draft === null}
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
                disabled={busy || draft === null}
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
          disabled={
            busy || name.trim().length === 0 || (!editing && memberNames(members).length === 0)
          }
          onClick={editing ? updateDraft : createDraft}
        >
          {editing ? 'Save configuration' : 'Create draft'}
        </Button>
        {editing && draft !== null ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="destructive" disabled={busy}>
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
