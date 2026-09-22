import { ref, onMounted, onUnmounted, nextTick } from "vue";

/**
 * Параллакс-эффект для фоновых орбов через одну секцию.
 * На мобилке отключён — мешает touch-скроллу и жрёт батарею.
 */
export const useParallaxSections = (speed = 0.1) => {
  const containerRef = ref<HTMLElement | null>(null);
  let ticking = false;
  let targets: { bg: HTMLElement; section: HTMLElement }[] = [];

  function collect() {
    if (!containerRef.value) return;
    targets = [];
    const sections = containerRef.value.querySelectorAll(".section");
    sections.forEach((section, i) => {
      if (i % 2 === 0) return;
      const bg = section.querySelector<HTMLElement>('[class*="__bg"]');
      if (!bg) return;
      bg.style.willChange = "transform";
      targets.push({ bg, section: section as HTMLElement });
    });
  }

  function update() {
    for (const { bg, section } of targets) {
      const rect = section.getBoundingClientRect();
      const offset = rect.top * speed;
      bg.style.transform = `translateY(${offset}px)`;
    }
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      update();
      ticking = false;
    });
  }

  onMounted(async () => {
    if (window.innerWidth < 768) return;

    await nextTick();
    // Ждём пока lazy-компоненты прогрузятся
    setTimeout(() => {
      collect();
      update();
    }, 600);
    window.addEventListener("scroll", onScroll, { passive: true });
  });

  onUnmounted(() => {
    window.removeEventListener("scroll", onScroll);
    targets = [];
  });

  return { containerRef };
};
