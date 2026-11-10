import { DataCache } from '@main/services/infrastructure/DataCache';
import { expect, it } from 'vitest';

// Observable on the predecessor too: a disposed context must never re-enable its cache.
it('does not resurrect a disposed cache through an enable transition', () => {
  const cache = new DataCache();
  cache.dispose();
  cache.setEnabled(true);
  expect(cache.isEnabled()).toBe(false);
});
