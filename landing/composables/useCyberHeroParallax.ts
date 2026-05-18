import type { Ref } from "vue";
import { nextTick, onMounted, onUnmounted } from "vue";

type PointerState = {
  x: number;
  y: number;
};

export function useCyberHeroParallax(rootRef: Ref<HTMLElement | null>) {
  let rafId = 0;
  let bounds: DOMRect | null = null;
  let reduceMotion: MediaQueryList | null = null;
  let canHover: MediaQueryList | null = null;
  let observer: IntersectionObserver | null = null;
  let isVisible = true;

  const pointer: PointerState = { x: 0, y: 0 };
  let scrollOffset = 0;

  const shouldRun = () => {
    if (reduceMotion?.matches) return false;
    if (canHover && !canHover.matches) return false;
    return window.innerWidth >= 768 && isVisible;
  };

  const writeVars = () => {
    rafId = 0;
    const root = rootRef.value;
    if (!root) return;

    if (!shouldRun()) {
      root.style.setProperty("--hero-pointer-x", "0");
      root.style.setProperty("--hero-pointer-y", "0");
      root.style.setProperty("--hero-scroll", "0");
      root.style.setProperty("--hero-tilt-x", "0");
      root.style.setProperty("--hero-tilt-y", "0");
      return;
    }

    root.style.setProperty("--hero-pointer-x", pointer.x.toFixed(4));
    root.style.setProperty("--hero-pointer-y", pointer.y.toFixed(4));
    root.style.setProperty("--hero-scroll", scrollOffset.toFixed(2));
    root.style.setProperty("--hero-tilt-x", pointer.x.toFixed(4));
    root.style.setProperty("--hero-tilt-y", pointer.y.toFixed(4));
  };

  const requestWrite = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(writeVars);
  };

  const updateBounds = () => {
    bounds = rootRef.value?.getBoundingClientRect() ?? null;
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!shouldRun()) return;
    if (!bounds) updateBounds();
    if (!bounds) return;

    const nextX = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    const nextY = ((event.clientY - bounds.top) / bounds.height) * 2 - 1;

    pointer.x = Math.max(-1, Math.min(1, nextX));
    pointer.y = Math.max(-1, Math.min(1, nextY));
    requestWrite();
  };

  const onPointerLeave = () => {
    pointer.x = 0;
    pointer.y = 0;
    requestWrite();
  };

  const onScroll = () => {
    const root = rootRef.value;
    if (!root || !shouldRun()) return;
    const rect = root.getBoundingClientRect();
    scrollOffset = Math.max(-600, Math.min(600, -rect.top));
    requestWrite();
  };

  const onResize = () => {
    updateBounds();
    requestWrite();
  };

  onMounted(async () => {
    await nextTick();
    const root = rootRef.value;
    if (!root) return;

    reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    canHover = window.matchMedia("(hover: hover) and (pointer: fine)");
    observer = new IntersectionObserver(
      ([entry]) => {
        isVisible = entry.isIntersecting;
        requestWrite();
      },
      { threshold: 0.05 },
    );

    observer.observe(root);
    updateBounds();
    root.addEventListener("pointermove", onPointerMove, { passive: true });
    root.addEventListener("pointerleave", onPointerLeave, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    reduceMotion.addEventListener("change", requestWrite);
    canHover.addEventListener("change", requestWrite);
    requestWrite();
  });

  onUnmounted(() => {
    const root = rootRef.value;
    if (rafId) cancelAnimationFrame(rafId);
    observer?.disconnect();
    root?.removeEventListener("pointermove", onPointerMove);
    root?.removeEventListener("pointerleave", onPointerLeave);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
    reduceMotion?.removeEventListener("change", requestWrite);
    canHover?.removeEventListener("change", requestWrite);
  });
}
