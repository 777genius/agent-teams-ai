/** Production always uses the fixed HTTPS publisher. Dev requires two isolated roots. */
export function announcementsSourcePolicy(
  production: boolean,
  isolatedProfile: boolean,
  override: string | undefined
): string | undefined {
  if (production || !isolatedProfile || !override) return undefined;
  try {
    const url = new URL(override);
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.pathname !== '/announcements/feed.v1.json' ||
      !['127.0.0.1', '[::1]'].includes(url.hostname)
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
