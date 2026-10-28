import { randomBytes, timingSafeEqual } from 'node:crypto';

import { MANAGEMENT_ACCESS_FRAGMENT } from '../../contracts';

/** A sidecar-only capability; never reuse or expose the Go engine's credential. */
export class ManagementHttpCapability {
  #secret?: Buffer;

  rotate(): void {
    this.#secret = randomBytes(32);
  }

  revoke(): void {
    this.#secret = undefined;
  }

  accepts(authorization?: string): boolean {
    if (!this.#secret || !authorization || !/^Bearer [a-f0-9]{64}$/.test(authorization))
      return false;
    return timingSafeEqual(this.#secret, Buffer.from(authorization.slice(7), 'hex'));
  }

  browserUrl(port: number): string {
    if (!this.#secret || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Start browser access in the desktop app before copying its link.');
    return `http://127.0.0.1:${port}/#${MANAGEMENT_ACCESS_FRAGMENT}=${this.#secret.toString('hex')}`;
  }
}
