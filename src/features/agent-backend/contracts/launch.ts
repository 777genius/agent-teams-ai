/** User options only; captured executable/account/environment/native identity stay private. */
export interface BackendLaunchConfiguration {
  members: {
    memberId: string;
    model?: string;
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    fastMode?: boolean;
    permissions?: 'manual' | 'bypass';
    context?: 'model-default' | 'one-million';
  }[];
}

export type BackendLaunchOption = 'model' | 'effort' | 'fastMode' | 'permissions' | 'context';

export interface BackendLaunchModelSelection {
  /** Desired application choices; private recipes remain with the original Team owner. */
  draft?: {
    providerId: 'anthropic' | 'codex' | 'opencode';
    target: { kind: 'lead' } | { kind: 'member'; name: string; originalName?: string };
    workspace?: string;
  };
  launchId: string;
  rosterRevision: string;
  memberId: string;
  model: string;
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  context?: 'model-default' | 'one-million';
}

/** Selected Team/member model observation; no global authentication or launch grant. */
export interface BackendLaunchModelProbe extends BackendLaunchModelSelection {
  commandId: string;
  phase: 'running' | 'completed' | 'cancelled' | 'held';
  ok: boolean;
  expiresAt: number;
}

/** Saved launch choices in the authorized Team context; not authentication/native observations. */
export interface BackendLaunchConfigurationView {
  launch: BackendLaunchSnapshot;
  members: {
    memberId: string;
    label: string;
    role: 'lead' | 'member';
    selected:
      | ({
          provider: 'claude' | 'codex' | 'opencode';
          workspace: string;
          /** Canonical saved member settings decide whether an edited Team workspace applies. */
          workspaceInherited?: boolean;
          model: string;
          capabilities: BackendLaunchOption[];
        } & Omit<BackendLaunchConfiguration['members'][number], 'memberId' | 'model'>)
      | null;
  }[];
}

/** Model-only saved/captured source; no native allocation or launch-readiness statement. */
export interface BackendLaunchModelConfigurationView {
  source: { sourceId: string; rosterRevision: string };
  members: BackendLaunchConfigurationView['members'];
}

/** Application launch identities and progress; native/configuration identities stay private. */
export interface BackendLaunchSnapshot {
  launchId: string;
  rosterRevision: string;
  /** Older captures may lack times; ordinary progress refuses to invent them. */
  startedAtMs?: number | null;
  observedAtMs?: number;
  status: 'ready' | 'pending' | 'partial' | 'failed';
  ready: number;
  expected: number;
  retryCapability: 'same-binding-no-allocation-only';
  /** Admitted original user intent; effective options/native identities are not returned here. */
  admission?: { commandId: string; sourceRosterRevision: string };
  members: {
    memberId: string;
    generation: string | null;
    attemptId: string;
    status:
      | 'not-started'
      | 'pending-bootstrap'
      | 'pending-human'
      | 'ready'
      | 'failed'
      | 'unknown'
      | 'skipped';
    nativeReady: boolean;
    usable: boolean;
    controlAvailable: boolean;
    noAllocation: boolean;
    reason: string;
  }[];
}
