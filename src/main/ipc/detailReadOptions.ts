/** Validate the documented boolean before admitting any detail work. */
export function normalizeDetailReadOptions(options: unknown): { bypassCache: boolean } | null {
  if (options === undefined) return { bypassCache: false };
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return null;
  if ('bypassCache' in options) {
    if (typeof options.bypassCache !== 'boolean') return null;
    return { bypassCache: options.bypassCache };
  }
  return { bypassCache: false };
}
