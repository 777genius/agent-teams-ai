export type { AppConnectionContext, ConnectionInfoV1 } from './contracts';
export {
  configureDesktopMcpEnvironment,
  getDesktopMcpChildEnvironment,
  isDesktopMcpControlAvailable,
  isDesktopMcpEnvironmentBound,
} from './core/application/desktopMcpEnvironment';
export { buildExternalAgentPrompt } from './core/domain/connectionPrompt';
