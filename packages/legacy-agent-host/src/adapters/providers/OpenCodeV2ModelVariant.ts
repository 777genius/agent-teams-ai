/** Compare the captured model variant with a native V2 owner readback.
 * OpenCode 2.0.0/2.0.21 fromRow materializes an omitted variant as "default".
 * The owner envelope uses null for absence; undefined is not an attestation.
 * Named variants remain exact and untrusted values are never coerced.
 */
export function matchesOpenCodeV2ModelVariant(
  captured: string | undefined,
  observed: unknown
): boolean {
  const valid = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    !/[\x00-\x1f\x7f]/.test(value);
  if (captured !== undefined && !valid(captured)) return false;
  if (observed !== null && !valid(observed)) return false;
  return (captured ?? 'default') === (observed ?? 'default');
}
