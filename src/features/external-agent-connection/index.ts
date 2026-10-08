export type { AppConnectionContext, ConnectionInfoV1 } from './contracts';
export {
  configureDesktopMcpEnvironment,
  getDesktopMcpChildEnvironment,
  isDesktopMcpEnvironmentBound,
} from './core/application/desktopMcpEnvironment';
export { buildExternalAgentPrompt } from './core/domain/connectionPrompt';
