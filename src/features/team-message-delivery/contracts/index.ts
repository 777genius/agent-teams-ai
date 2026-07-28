export {
  TEAM_GET_ATTACHMENTS,
  TEAM_GET_RUNTIME_DELIVERY_STATUS,
  TEAM_PROCESS_ALIVE,
  TEAM_PROCESS_SEND,
  TEAM_SEND_MESSAGE,
} from './channels';
export type {
  RuntimeDeliveryStatus,
  RuntimeDeliveryUserVisibleImpact,
  RuntimeDeliveryUserVisibleState,
} from './runtime-delivery';

// Desktop compatibility exports. The feature root intentionally does not
// re-export this provider-specific surface.
export type { OpenCodeRuntimeDeliveryStatus } from './compatibility/open-code-delivery';
export { TEAM_GET_OPENCODE_RUNTIME_DELIVERY_STATUS } from './compatibility/open-code-delivery';
