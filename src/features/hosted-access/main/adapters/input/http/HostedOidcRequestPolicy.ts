import { parseOidcLoginAttemptId } from '../../../../contracts';
import {
  type AdmissionWindow,
  admitFixedWindow,
  OIDC_BACKCHANNEL_GLOBAL_LIMIT,
  OIDC_BACKCHANNEL_LIMIT_PER_SOURCE,
  OIDC_BACKCHANNEL_MAX_CONCURRENCY,
  OIDC_LOGIN_LIMIT_PER_SOURCE,
  OIDC_LOGIN_WINDOW_MS,
  safeReturnTo,
} from '../../../../core/domain';

export class HostedOidcRequestPolicy {
  private readonly loginAdmission = new Map<string, AdmissionWindow>();
  private readonly backchannelAdmission = new Map<string, AdmissionWindow>();
  private readonly backchannelGlobalAdmission: AdmissionWindow = { startedAt: 0, count: 0 };
  private backchannelInFlight = 0;

  returnTo(value: unknown, publicOrigin: string): string {
    return safeReturnTo(value, publicOrigin);
  }

  parseLoginAttemptId(value: string) {
    return parseOidcLoginAttemptId(value);
  }

  admitLogin(source: string): boolean {
    return admitFixedWindow(this.loginAdmission, source, Date.now(), OIDC_LOGIN_LIMIT_PER_SOURCE);
  }

  admitBackchannel(source: string): boolean {
    if (this.backchannelInFlight >= OIDC_BACKCHANNEL_MAX_CONCURRENCY) return false;
    const now = Date.now();
    const global = this.backchannelGlobalAdmission;
    if (now - global.startedAt >= OIDC_LOGIN_WINDOW_MS) {
      global.startedAt = now;
      global.count = 0;
    }
    if (global.count >= OIDC_BACKCHANNEL_GLOBAL_LIMIT) return false;
    if (
      !admitFixedWindow(this.backchannelAdmission, source, now, OIDC_BACKCHANNEL_LIMIT_PER_SOURCE)
    ) {
      return false;
    }
    global.count += 1;
    this.backchannelInFlight += 1;
    return true;
  }

  leaveBackchannel(): void {
    this.backchannelInFlight -= 1;
  }
}
