import { sectionOrder } from "~/data/sections";

export const useTrackSections = () => {
  if (!import.meta.client) return;

  const { trackSectionView } = useAnalytics();
  const seen = new Set<string>();

  let observer: IntersectionObserver | null = null;

  onMounted(() => {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = entry.target.id;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          trackSectionView(id);
          observer?.unobserve(entry.target);
        }
      },
      { threshold: 0.3, rootMargin: "0px 0px -10% 0px" },
    );

    for (const sectionId of sectionOrder) {
      const el = document.getElementById(sectionId);
      if (el) observer.observe(el);
    }
  });

  onUnmounted(() => {
    observer?.disconnect();
  });
};
