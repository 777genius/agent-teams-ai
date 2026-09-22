import { buildOpenCodeRuntimeDeliveryUserVisibleImpact } from '@main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';

import type { RuntimeDeliveryUserVisibleImpact } from '../../../contracts/runtime-delivery';
import type { RuntimeDeliveryImpactPort } from '../../../core/application/ports/TeamMessageDeliveryPorts';
import type { RuntimeRelayDelivery } from '../../../core/domain/messageDeliveryModels';

export class OpenCodeDeliveryImpactAdapter implements RuntimeDeliveryImpactPort {
  buildImpact(delivery: RuntimeRelayDelivery): RuntimeDeliveryUserVisibleImpact {
    return buildOpenCodeRuntimeDeliveryUserVisibleImpact(delivery);
  }
}
