import type { TeamMessageNotificationData } from '@shared/types';

export interface TeamTaskNotificationTransportPort {
  show(data: TeamMessageNotificationData): Promise<void>;
}
