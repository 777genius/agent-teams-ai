import { FreezeHostedPromotion } from '../../core/application/hosted-authority/FreezeHostedPromotion';

import type { HostedPromotionPrerequisitePorts } from '../../core/application/hosted-authority/FreezeHostedPromotion';

/** Opt-in source seam. Not registered in HTTP or startup; no actual Owner adapter exists here. */
export function createHostedPromotionPrerequisite(ports: HostedPromotionPrerequisitePorts) {
  return new FreezeHostedPromotion(ports);
}
