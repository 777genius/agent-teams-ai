import {
  cookie,
  DEVICE_COOKIE,
  type HostedHttpReply,
  SESSION_COOKIE,
} from '../../../../core/domain';

export function setHostedCredentialCookies(
  reply: HostedHttpReply,
  sessionSecret: string,
  deviceSecret: string,
  options: {
    readonly sessionMaxAgeSeconds: number;
    readonly deviceMaxAgeSeconds: number;
    readonly secureCookies: boolean;
  }
): void {
  reply.header('set-cookie', [
    cookie(SESSION_COOKIE, sessionSecret, {
      maxAge: options.sessionMaxAgeSeconds,
      secure: options.secureCookies,
      sameSite: 'Strict',
    }),
    cookie(DEVICE_COOKIE, deviceSecret, {
      maxAge: options.deviceMaxAgeSeconds,
      secure: options.secureCookies,
      sameSite: 'Strict',
    }),
  ]);
}
