import type { Ref } from "vue";
import { nextTick, onMounted, onUnmounted } from "vue";

export function useCyberHeroParallax(rootRef: Ref<HTMLElement | null>) {
  let rafId = 0;
  let reduceMotion: MediaQueryList | null = null;
  let observer: IntersectionObserver | null = null;
  let isVisible = true;
  let scrollOffset = 0;

  const shouldRun = () => {
    if (reduceMotion?.matches) return false;
    return window.innerWidth >= 768 && isVisible;
  };

  const writeVars = () => {
    rafId = 0;
    const root = rootRef.value;
    if (!root) return;

    root.style.setProperty("--hero-pointer-x", "0");
    root.style.setProperty("--hero-pointer-y", "0");
    root.style.setProperty("--hero-tilt-x", "0");
    root.style.setProperty("--hero-tilt-y", "0");

    if (!shouldRun()) {
      root.style.setProperty("--hero-scroll", "0");
      return;
    }

    root.style.setProperty("--hero-scroll", scrollOffset.toFixed(2));
  };

  const requestWrite = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(writeVars);
  };

  const onScroll = () => {
    const root = rootRef.value;
    if (!root || !shouldRun()) return;
    const rect = root.getBoundingClientRect();
    scrollOffset = Math.max(-600, Math.min(600, -rect.top));
    requestWrite();
  };

  const onResize = () => {
    requestWrite();
  };

  onMounted(async () => {
    await nextTick();
    const root = rootRef.value;
    if (!root) return;

    reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    observer = new IntersectionObserver(
      ([entry]) => {
        isVisible = entry.isIntersecting;
        requestWrite();
      },
      { threshold: 0.05 },
    );

    observer.observe(root);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    reduceMotion.addEventListener("change", requestWrite);
    requestWrite();
  });

  onUnmounted(() => {
    if (rafId) cancelAnimationFrame(rafId);
    observer?.disconnect();
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
    reduceMotion?.removeEventListener("change", requestWrite);
  });
}
