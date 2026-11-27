export type { AppConnectionContext, ConnectionInfoV1 } from './contracts';
export {
  configureDesktopMcpEnvironment,
  getDesktopMcpChildEnvironment,
  isDesktopMcpControlAvailable,
  isDesktopMcpEnvironmentBound,
} from './core/application/desktopMcpEnvironment';
export {
  buildExternalAgentPrompt,
  buildMcpRegistrationCommand,
} from './core/domain/connectionPrompt';
export {
  buildConnectionSetupPrompt,
  hasReadyRendererAccess,
} from './core/domain/connectionSetupPrompt';
