import { AuthorityCore, type HostedAccessAuthorityDependencies } from './AuthorityCore';
import { PairingAuthority } from './PairingAuthority';
import { ResetAuthority } from './ResetAuthority';
import { SessionAuthority } from './SessionAuthority';

import type { AuthorityBinding, CsrfToken, OpaqueAuthoritySecret } from '../../contracts';

/**
 * Pure Phase 6 operator-authority facade.
 *
 * All effects cross the narrow ports in HostedAccessAuthorityDependencies.
 * Transport adapters are deliberately outside this slice.
 */
export class HostedAccessAuthority {
  private readonly pairing: PairingAuthority;
  private readonly sessions: SessionAuthority;
  private readonly reset: ResetAuthority;

  constructor(dependencies: HostedAccessAuthorityDependencies) {
    const core = new AuthorityCore(dependencies);
    this.pairing = new PairingAuthority(core);
    this.sessions = new SessionAuthority(core);
    this.reset = new ResetAuthority(core);
  }

  initialize(binding: AuthorityBinding) {
    return this.pairing.initialize(binding);
  }

  issueInitialChallenge(binding: AuthorityBinding) {
    return this.pairing.issueInitialChallenge(binding);
  }

  pair(binding: AuthorityBinding, pairingSecret: OpaqueAuthoritySecret) {
    return this.pairing.pair(binding, pairingSecret);
  }

  renew(binding: AuthorityBinding, deviceSecret: OpaqueAuthoritySecret) {
    return this.sessions.renew(binding, deviceSecret);
  }

  authenticate(binding: AuthorityBinding, sessionSecret: OpaqueAuthoritySecret) {
    return this.sessions.authenticate(binding, sessionSecret);
  }

  bootstrapSession(binding: AuthorityBinding, sessionSecret: OpaqueAuthoritySecret) {
    return this.sessions.bootstrapSession(binding, sessionSecret);
  }

  verifyCsrf(
    binding: AuthorityBinding,
    sessionSecret: OpaqueAuthoritySecret,
    csrfToken: CsrfToken
  ) {
    return this.sessions.verifyCsrf(binding, sessionSecret, csrfToken);
  }

  logout(binding: AuthorityBinding, sessionSecret: OpaqueAuthoritySecret) {
    return this.sessions.logout(binding, sessionSecret);
  }

  forgetDevice(binding: AuthorityBinding, sessionSecret: OpaqueAuthoritySecret) {
    return this.sessions.forgetDevice(binding, sessionSecret);
  }

  consumeResetGeneration(binding: AuthorityBinding, resetGeneration: number) {
    return this.reset.consumeResetGeneration(binding, resetGeneration);
  }
}
