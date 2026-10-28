import { useCallback, useEffect, useRef } from 'react';

import { api } from '@renderer/api';

import type { SkillReviewPreview, SkillsCatalogAPI } from '@shared/types/extensions';

type DiscardReview = SkillsCatalogAPI['discardReview'];
interface RetainedReview {
  preview: SkillReviewPreview;
  discard: DiscardReview;
  releasing?: Promise<void>;
}

async function discardLocalReview(planId: string): Promise<void> {
  if (!api.skills) throw new Error('Local Skill reviews are unavailable in this host.');
  await api.skills.discardReview(planId);
}

/** Each preview keeps its own owner, including results that arrive after close. */
export function useSkillReviewLifecycle(open: boolean, discard = discardLocalReview) {
  const retained = useRef<RetainedReview | null>(null);
  const generation = useRef(0);
  const active = useRef(open);
  const release = useCallback(async () => {
    const review = retained.current;
    if (!review) return;
    review.releasing ??= review.discard(review.preview.planId).catch((error: unknown) => {
      review.releasing = undefined;
      throw error;
    });
    await review.releasing;
    if (retained.current === review) retained.current = null;
  }, []);
  const abandon = useCallback(async () => {
    generation.current += 1;
    await release();
  }, [release]);
  useEffect(() => {
    active.current = open;
    if (!open) void abandon().catch(() => {});
    return () => {
      active.current = false;
      void abandon().catch(() => {});
    };
  }, [abandon, open]);
  const prepare = useCallback(
    async (create: () => Promise<SkillReviewPreview>) => {
      const version = ++generation.current;
      await release();
      if (!active.current || version !== generation.current) return null;
      let preview: SkillReviewPreview;
      try {
        preview = await create();
      } catch (error) {
        if (!active.current || version !== generation.current) return null;
        throw error;
      }
      if (!active.current || version !== generation.current) {
        await discard(preview.planId);
        return null;
      }
      retained.current = { preview, discard };
      return preview;
    },
    [discard, release]
  );
  return { prepare, abandon };
}
