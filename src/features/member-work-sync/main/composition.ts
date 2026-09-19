export {
  buildMemberWorkSyncRuntimeTurnSettledEnvironment,
  createMemberWorkSyncFeature,
} from './composition/createMemberWorkSyncFeature';

import {
  buildOpenCodeWorkSyncLaneDeliveryGateInput,
  gateOpenCodeWorkSyncLaneDelivery,
} from './adapters/output/gateOpenCodeWorkSyncLaneDelivery';
import { readNativeWorkSyncCurrentRuntimeInstanceId } from './adapters/output/NativeMailboxMemberWorkSyncRuntimeTicketAdmission';
import { sendOpenCodeWorkSyncAdmittedMessage } from './adapters/output/sendOpenCodeWorkSyncAdmittedMessage';
import { createMemberWorkSyncRuntimeDelivery } from './composition/memberWorkSyncRuntimeDelivery';

/** Concrete Node runtime delivery wiring; app-shell callers import the explicit composition facet. */
export const memberWorkSyncRuntimeDelivery = createMemberWorkSyncRuntimeDelivery({
  prepareOpenCodeDeliveryLane: (input) =>
    gateOpenCodeWorkSyncLaneDelivery(buildOpenCodeWorkSyncLaneDeliveryGateInput(input)),
  sendOpenCodeAdmittedMessage: (input) => sendOpenCodeWorkSyncAdmittedMessage(input),
  readCurrentNativeRuntimeInstanceId: readNativeWorkSyncCurrentRuntimeInstanceId,
});
