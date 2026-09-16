import { productionMemberLogObservationRendererPorts } from './adapters/createMemberLogObservationRendererPorts';
import { configureMemberLogObservationRendererPorts } from './ports/MemberLogObservationRendererPorts';

configureMemberLogObservationRendererPorts(productionMemberLogObservationRendererPorts);

export { MemberLogStreamSection } from './MemberLogStreamSection';
export type {
  MemberLogObservationChange,
  MemberLogObservationListener,
  MemberLogObservationRendererPorts,
  MemberLogStreamQuery,
  MemberLogTaskQuery,
  MemberLogWorkInterval,
} from './ports/MemberLogObservationRendererPorts';
export { memberLogObservationPorts } from './ports/MemberLogObservationRendererPorts';
export {
  buildDefaultExecutionSegmentRenderKey,
  normalizeExecutionLogStream,
} from './ui/executionLogStreamUtils';
export { ExecutionLogStreamView } from './ui/ExecutionLogStreamView';
export { isMemberLogStreamUiEnabled } from './utils/featureGates';
