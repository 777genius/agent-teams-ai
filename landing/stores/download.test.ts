import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDownloadStore } from "./download";

const platformMocks = vi.hoisted(() => ({
  detectArchFromNavigator: vi.fn(),
  detectMacArchFromNavigator: vi.fn(),
  detectPlatform: vi.fn(),
}));

vi.mock("~/utils/platform", () => platformMocks);

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("landing download store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.resetAllMocks();
    platformMocks.detectPlatform.mockReturnValue("windows");
  });

  it.each(["windows-x64", "linux-appimage"])(
    "preserves a manual %s selection while Windows architecture detection is pending",
    async (selectedId) => {
      const detection = deferred<"arm64">();
      platformMocks.detectArchFromNavigator.mockReturnValue(detection.promise);
      const store = useDownloadStore();

      const initialization = store.init();
      store.setSelected(selectedId);
      detection.resolve("arm64");
      await initialization;

      expect(store.selectedId).toBe(selectedId);
      expect(store.selectionSource).toBe("manual");
    },
  );

  it("preserves a manual macOS architecture while Windows detection is pending", async () => {
    const detection = deferred<"arm64">();
    platformMocks.detectArchFromNavigator.mockReturnValue(detection.promise);
    const store = useDownloadStore();

    const initialization = store.init();
    store.setMacArch("x64");
    detection.resolve("arm64");
    await initialization;

    expect(store.os).toBe("macos");
    expect(store.arch).toBe("x64");
    expect(store.selectedId).toBe("macos");
  });
});
