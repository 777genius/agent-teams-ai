import type { NativeAttachmentCapabilities } from '../../attachments/attachmentTypes.js';
import type { ClaudeConfig, ClaudeDriverHost } from '@agent-teams/provider-implementations/claude';
import type {
  RegisteredProcessRootSource,
  RegisteredProcessCapture,
  RegistrarBinding,
} from '../../process/registeredProcessContracts.js';
import type { DriverFactory, OpenConfig, Session } from '@agent-teams/provider-session-contracts';
import type { TeamMcpEndpoint, TeamMcpConnection } from '../../mcp/contracts.js';
import type { NativeContextEvidence } from '../../team-launch/contracts.js';
import type { RuntimeMemberProfile } from '../../composition/runtimeProfile.js';
import type { ToolEvidenceCapture } from '../../evidence/captureContracts.js';
import type { CodexEvidenceCapture } from '../../evidence/codexCaptureContracts.js';
import type { OpenCodeEvidenceCapture } from '../../evidence/opencodeCaptureContracts.js';
import type { NativeSessionCommandCapability } from '../../team/nativeSessionCommand.js';
import type { WindowsServiceIntent } from '../../owned-process/retainedServiceContracts.js';
import type { HostWindowsLaunch } from '../../owned-process/HostWindowsLaunch.js';
import type { RuntimeSourceProcessOrigin } from '../../composition/runtimeSourceProcessOrigin.js';

export interface MemberProviderContext {
  profile: RuntimeMemberProfile;
  processCustody?: RegisteredProcessRootSource;
  /** Private original Main launch capability for process-backed providers. */
  retainedWindowsLaunch?: HostWindowsLaunch;
  processOrigin?: RuntimeSourceProcessOrigin;
  request: OpenConfig;
  endpoint: TeamMcpEndpoint;
  connection: TeamMcpConnection;
  instructions: string;
  subagents?: import('@agent-teams/provider-implementations/claude').ClaudeSubagentPort;
  attachments?: NonNullable<ClaudeConfig['attachments']>;
  toolEvidence?: ToolEvidenceCapture;
  codexEvidence?: CodexEvidenceCapture;
  opencodeEvidence?: OpenCodeEvidenceCapture;
  isCurrent(): boolean;
  canAllocate(): boolean;
  /** Team-fenced physical capture; original Runtime input is checked by the outer MCP wrapper. */
  canCaptureRegisteredProcess?(): boolean;
  readCheckpoint(reference: string, request: OpenConfig): Promise<unknown>;
  readCheckpointSource?: NonNullable<ClaudeDriverHost['readCheckpointSource']>;
  onProgress(): void;
}

export interface MemberProvider {
  factory: DriverFactory;
  readonly attachmentCapabilities?: Readonly<NativeAttachmentCapabilities>;
  /** Live captured provider capability, never a renderer-declared provider or arbitrary skill path. */
  sessionCommands?(): readonly NativeSessionCommandCapability[];
  captureRegisteredProcess?(pid: number, registrar: RegistrarBinding): RegisteredProcessCapture;
  prepareRegisteredWindowsProcess?(pid: number, registrar: RegistrarBinding): WindowsServiceIntent;
  isReady(): boolean;
  /** Installed exact initial context, acknowledged through successful D native configuration/readiness. */
  initialContextEvidence?(): NativeContextEvidence | undefined;
  /** Composition-only final evidence for Runtime's original closing/owned/idle session. */
  checkpointBeforeClose?(sessionRef: string): ReturnType<Session['checkpoint']>;
  seal(): void;
  cleanup(): Promise<boolean>;
}
