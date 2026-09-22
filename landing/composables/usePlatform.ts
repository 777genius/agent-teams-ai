import { computed, onMounted, ref } from "vue";
import { detectMacArchFromNavigator, detectPlatform } from "~/utils/platform";

export const usePlatform = () => {
  const platform = ref("unknown");
  const arch = ref("unknown");

  onMounted(async () => {
    platform.value = detectPlatform(navigator);
    if (platform.value === "macos") {
      arch.value = await detectMacArchFromNavigator(navigator);
    }
  });

  const label = computed(() => {
    if (platform.value === "macos") return "macOS";
    if (platform.value === "windows") return "Windows";
    if (platform.value === "linux") return "Linux";
    return "your OS";
  });

  return { platform, arch, label };
};
