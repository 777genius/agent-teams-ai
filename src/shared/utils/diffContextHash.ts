/**
 * Computes a stable, lightweight hash for diff context matching.
 *
 * This is intentionally NON-cryptographic and designed for:
 * - matching hunks/snippets across processes
 * - tolerating small differences by using head/tail windows
 */
export function computeDiffContextHash(oldString: string, newString: string): string {
  const take3 = (s: string): string => {
    const lines = s.split('\n');
    const head = lines.slice(0, 3).join('\n');
    const tail = lines.length > 3 ? lines.slice(-3).join('\n') : '';
    return `${head}|${tail}`;
  };
  const raw = `${take3(oldString)}::${take3(newString)}`;
  // DJB2 variant
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
