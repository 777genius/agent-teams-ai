import { buildOpenCodeRuntimeDeliveryUserVisibleImpact } from '@main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';

import type { OpenCodeDeliveryImpactPort } from '../../../core/application/ports/TeamMessageDeliveryPorts';
import type { OpenCodeRelayDelivery } from '../../../core/domain/messageDeliveryModels';
import type { OpenCodeRuntimeDeliveryUserVisibleImpact } from '@shared/types';

export class OpenCodeDeliveryImpactAdapter implements OpenCodeDeliveryImpactPort {
  buildImpact(delivery: OpenCodeRelayDelivery): OpenCodeRuntimeDeliveryUserVisibleImpact {
    return buildOpenCodeRuntimeDeliveryUserVisibleImpact(delivery);
  }
}
