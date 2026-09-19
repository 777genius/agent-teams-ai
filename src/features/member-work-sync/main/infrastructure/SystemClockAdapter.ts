import type { MemberWorkSyncClockPort } from '../../core/application';

export class SystemClockAdapter implements MemberWorkSyncClockPort {
  now(): Date {
    return new Date();
  }

  delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
