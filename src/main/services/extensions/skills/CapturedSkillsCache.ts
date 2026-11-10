import type { CapturedSkillsCollection } from './CapturedSkillsCollection';

/** Keep original import grants and selected inode identity across existing IPC preview/apply calls. */
export class CapturedSkillsCache {
  private readonly entries = new Map<
    string,
    { current(): boolean; value: Promise<CapturedSkillsCollection> }
  >();
  capture(
    key: string,
    current: () => boolean,
    load: () => Promise<CapturedSkillsCollection>
  ): Promise<CapturedSkillsCollection> {
    if (!current()) throw new Error('Original Skills context changed');
    for (const [id, entry] of this.entries) if (!entry.current()) this.entries.delete(id);
    const previous = this.entries.get(key);
    if (previous) return previous.value;
    const value = load().then((result) => {
      result.assertCurrent();
      return result;
    });
    this.entries.set(key, { current, value });
    // A failed original capture stays failed for that context; no replacement-root adoption.
    return value;
  }
}
