import type { HostedHttpRequest } from '../../../../core/domain';

export function isTrustedHostedOrigin(request: HostedHttpRequest, publicOrigin: string): boolean {
  const origin = request.headers.origin;
  const fetchSite = request.headers['sec-fetch-site'];
  return (
    origin === publicOrigin &&
    (fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'same-site')
  );
}
