import type { MemberWorkSyncClockPort } from '../../core/application';

export class SystemClockAdapter implements MemberWorkSyncClockPort {
  now(): Date {
    return new Date();
  }
}
