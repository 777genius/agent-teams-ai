import { useEffect, useRef, useState } from 'react';

import { isHostTeamSelectionKey } from '@features/agent-backend/contracts';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';

import {
  createHostTeamResume,
  hasUnresolvedHostResume,
  HostTeamResumeUnavailable,
  pendingHostResume,
} from './createHostTeamResume';

import type { HostTeamResumeSource } from './createHostTeamResume';
import type { HostTeamResumeControls } from './HostTeamResumeSection';

/** Dialog observations only. Admitted commands and outcomes remain owned by Team. */
export function useHostTeamResume(input: {
  open: boolean;
  enabled: boolean;
  teamName: string;
  mode: 'fresh' | 'resume';
  onModeChange: (mode: 'fresh' | 'resume') => void;
}) {
  const context = useStore((state) =>
    JSON.stringify([
      state.activeContextId,
      state.targetContextId,
      state.isContextSwitching,
      state.connectionMode,
      state.connectedHost,
      state.appConfig?.general?.claudeRootPath,
    ])
  );
  const visible = input.enabled && isHostTeamSelectionKey(input.teamName);
  const scope = JSON.stringify([input.open, visible, input.teamName, context]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const [observation, setObservation] = useState<{
    scope: string;
    controller: ReturnType<typeof createHostTeamResume>;
    source: HostTeamResumeSource;
  } | null>(null);
  const active = observation?.scope === scope ? observation : null;
  const [loading, setLoading] = useState(false);
  const [freshScope, setFreshScope] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const baseline = useRef<{ scope: string; signature: string } | null>(null);
  const busy = useRef(false);
  const setMode = useRef(input.onModeChange);
  setMode.current = input.onModeChange;

  useEffect(() => {
    baseline.current = null;
    setObservation(null);
    setSelections({});
    setSubmitted(false);
    setMessage(null);
    setFreshScope(null);
    setLoading(false);
    if (!input.open || !visible) return;
    setMode.current('fresh');
    let cancelled = false;
    const current = () => !cancelled && latestScope.current === scope;
    const controller = createHostTeamResume({
      backend: api.agentBackend,
      teamName: input.teamName,
      current,
      getSavedRequest: (teamName) => api.teams.getSavedRequest(teamName),
    });
    setLoading(true);
    void controller
      .read()
      .then((source) => {
        if (!current()) return;
        setObservation({ scope, controller, source });
        if (!hasUnresolvedHostResume(source.restorations)) setFreshScope(scope);
        if (hasUnresolvedHostResume(source.restorations)) {
          const prepared = pendingHostResume(source.restorations);
          setMode.current('resume');
          setSubmitted(prepared ? prepared.members.some((member) => member.requested) : true);
          setSelections(
            Object.fromEntries(
              prepared
                ? prepared.members.map((member) => [member.memberId, member.reference])
                : source.restorations.restorations
                    .filter((row) => row.current)
                    .map((row) => [row.memberId, row.reference])
            )
          );
          setMessage(
            prepared?.members.every((member) => !member.requested)
              ? 'The original checkpoint selection is prepared. Resume uses those same member commands.'
              : 'An original Resume is already submitted. Check its status; no new launch will be started.'
          );
        }
      })
      .catch((error: unknown) => {
        if (current() && error instanceof HostTeamResumeUnavailable) setFreshScope(scope);
        if (current())
          setMessage(
            error instanceof Error ? error.message : 'Original Resume status unavailable.'
          );
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, input.open, input.teamName, visible]);

  return {
    canFreshPreflight:
      !visible ||
      (freshScope === scope && !(active && hasUnresolvedHostResume(active.source.restorations))),
    qualify(form: {
      hydrated: boolean;
      sourceRevision?: string;
      edited: boolean;
      formSignature: string;
      onReady: () => void;
    }) {
      if (
        active &&
        form.hydrated &&
        !form.edited &&
        form.sourceRevision === active.source.savedRequest.savedSettingsFingerprint &&
        baseline.current?.scope !== scope
      )
        baseline.current = { scope, signature: form.formSignature };
      const changed = form.edited || baseline.current?.signature !== form.formSignature;
      const prepared = active ? pendingHostResume(active.source.restorations) : undefined;
      const queryOnly =
        submitted ||
        Boolean(prepared?.members.some((member) => member.requested)) ||
        Boolean(active && !prepared && hasUnresolvedHostResume(active.source.restorations));
      const locked = queryOnly || Boolean(prepared) || Boolean(active?.controller.hasIntent());
      const formMessage =
        active && form.hydrated && changed && !queryOnly
          ? 'Settings changed. Use Fresh Launch to apply the edited configuration.'
          : null;
      const missing =
        !active ||
        active.source.members.some(
          (member) =>
            member.availability.status !== 'owner-eligible' ||
            !member.availability.checkpoints.some(
              (checkpoint) =>
                checkpoint.reference === selections[member.memberId] &&
                checkpoint.status === 'owner-eligible'
            )
        );
      async function submit(): Promise<boolean> {
        if (!active || loading || busy.current) return false;
        if (!queryOnly && (changed || missing || !form.hydrated))
          throw new Error(
            formMessage ?? 'Select an available saved checkpoint for every teammate.'
          );
        busy.current = true;
        setLoading(true);
        try {
          const result = await active.controller.submit(active.source, selections);
          if (latestScope.current !== scope) return false;
          setObservation({
            ...active,
            source: { ...active.source, restorations: result.restorations },
          });
          setMessage(
            result.ready
              ? 'Original Resume is ready.'
              : 'Original Resume remains pending or unknown. Check status to query the original commands.'
          );
          if (result.ready) {
            await useStore.getState().refreshTeamData(input.teamName);
            if (latestScope.current === scope) {
              useStore.getState().openTeamTab(input.teamName, active.source.savedRequest.cwd);
              form.onReady();
            }
          }
          return result.ready;
        } finally {
          busy.current = false;
          if (latestScope.current === scope) {
            setLoading(false);
            setSubmitted(active.controller.hasSubmitted());
          }
        }
      }
      const controls: HostTeamResumeControls = {
        visible,
        mode: input.mode,
        onModeChange: input.onModeChange,
        source: active?.source ?? null,
        loading,
        locked: locked || loading,
        selections,
        onSelectionChange: (memberId, reference) => {
          if (!locked) setSelections((previous) => ({ ...previous, [memberId]: reference }));
        },
        message: formMessage ?? message,
      };
      return {
        controls,
        submit,
        selected: visible && input.mode === 'resume',
        disabled: loading || !active || (!queryOnly && (changed || missing || !form.hydrated)),
        label: queryOnly ? 'Check Resume status' : 'Resume selected checkpoints',
      };
    },
  };
}
