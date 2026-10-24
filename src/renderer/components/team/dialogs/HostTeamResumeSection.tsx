import React from 'react';

import { Combobox } from '@renderer/components/ui/combobox';
import { Label } from '@renderer/components/ui/label';

import type { HostTeamResumeSource } from './createHostTeamResume';
import type { BackendCheckpointAvailabilityReason } from '@features/agent-backend/contracts';

const availabilityExplanation: Record<BackendCheckpointAvailabilityReason, string> = {
  'native-backing-unverified': 'Saved history will be checked on resume.',
  unsupported: 'This agent does not support saved checkpoints.',
  'source-unavailable': 'The original agent is unavailable.',
  'checkpoint-unavailable': 'Saved history is unavailable.',
  'checkpoint-budget': 'Saved history is unavailable.',
  'checkpoint-invalid': 'Saved history is unavailable.',
  'payload-unavailable': 'Saved history is unavailable.',
  'custody-unreleased': 'Wait for this agent to stop.',
  'history-changed': 'Saved history changed; use Fresh Launch.',
  'configuration-changed': 'Settings changed; use Fresh Launch.',
  'generation-conflict': 'This agent changed; reopen Launch to check its history.',
  'sibling-unreleased': 'Wait for the other agents to stop.',
};

export interface HostTeamResumeControls {
  visible: boolean;
  mode: 'fresh' | 'resume';
  onModeChange: (mode: 'fresh' | 'resume') => void;
  source: HostTeamResumeSource | null;
  loading: boolean;
  locked: boolean;
  selections: Record<string, string>;
  onSelectionChange: (memberId: string, reference: string) => void;
  message: string | null;
}

/** Explicit application checkpoint choices live in the original Launch dialog. */
export const HostTeamResumeSection = ({ controls }: { controls: HostTeamResumeControls }) => {
  if (!controls.visible) return null;
  return (
    <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3 text-xs">
      <Label htmlFor="launch-continuation-mode">Launch mode</Label>
      <Combobox
        id="launch-continuation-mode"
        value={controls.mode}
        onValueChange={(value) => controls.onModeChange(value === 'resume' ? 'resume' : 'fresh')}
        disabled={controls.locked}
        options={[
          { value: 'fresh', label: 'Fresh Launch' },
          { value: 'resume', label: 'Resume checkpoint' },
        ]}
      />
      {controls.mode === 'resume' ? (
        <>
          <p className="text-[var(--color-text-muted)]">
            Choose a saved checkpoint for each teammate. Saved history is checked when resuming.
          </p>
          {controls.source?.members.map(({ memberId, label, availability }) => (
            <div key={memberId} className="space-y-1">
              <Label htmlFor={`resume-checkpoint-${memberId}`}>{label}</Label>
              <Combobox
                id={`resume-checkpoint-${memberId}`}
                value={controls.selections[memberId] ?? ''}
                placeholder="Select an explicit checkpoint"
                onValueChange={(reference) => controls.onSelectionChange(memberId, reference)}
                disabled={
                  controls.loading || controls.locked || availability.status !== 'owner-eligible'
                }
                options={availability.checkpoints.map((checkpoint, index) => ({
                  value: checkpoint.reference,
                  label: `Saved checkpoint ${index + 1}`,
                  description:
                    checkpoint.status === 'owner-eligible'
                      ? 'Saved history will be checked on resume.'
                      : availabilityExplanation[checkpoint.reason],
                  disabled: checkpoint.status !== 'owner-eligible',
                }))}
              />
              {availability.status !== 'owner-eligible' ? (
                <p className="text-[var(--color-text-muted)]">
                  {availabilityExplanation[availability.reason]}
                </p>
              ) : null}
            </div>
          ))}
          {controls.loading ? <p role="status">Reading original Resume status…</p> : null}
          {controls.message ? <p role="status">{controls.message}</p> : null}
        </>
      ) : null}
      {controls.mode === 'fresh' && controls.message && !controls.loading ? (
        <p role="status">{controls.message}</p>
      ) : null}
    </div>
  );
};
