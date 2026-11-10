/** Copy input is a one-shot initializer, not a template to reapply on remount. */
const consumed = new WeakSet<object>();

export function consumeTeamCopySeedOnce(seed: object): boolean {
  if (consumed.has(seed)) return false;
  consumed.add(seed);
  return true;
}
