import type { ClaudeConfig } from '@agent-teams/provider-implementations/claude';
import type {
  RegisteredProcessRootSource,
  RegisteredProcessCapture,
  RegistrarBinding,
} from '../../process/registeredProcessContracts.js';
import type { DriverFactory, OpenConfig } from '@agent-teams/provider-session-contracts';
import type { TeamMcpEndpoint, TeamMcpConnection } from '../../mcp/contracts.js';
import type { NativeContextEvidence } from '../../team-launch/contracts.js';
import type { RuntimeMemberProfile } from '../../composition/runtimeProfile.js';
import type { ToolEvidenceCapture } from '../../evidence/captureContracts.js';
import type { CodexEvidenceCapture } from '../../evidence/codexCaptureContracts.js';
import type { OpenCodeEvidenceCapture } from '../../evidence/opencodeCaptureContracts.js';

export interface MemberProviderContext {
  profile: RuntimeMemberProfile;
  processCustody?: RegisteredProcessRootSource;
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
  onProgress(): void;
}

export interface MemberProvider {
  factory: DriverFactory;
  captureRegisteredProcess?(pid: number, registrar: RegistrarBinding): RegisteredProcessCapture;
  isReady(): boolean;
  /** Installed exact initial context, acknowledged through successful D native configuration/readiness. */
  initialContextEvidence?(): NativeContextEvidence | undefined;
  seal(): void;
  cleanup(): Promise<boolean>;
}
