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

  it.each(["windows", "linux-appimage"])(
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

  it("selects the unified Windows card and preserves a manual Windows architecture", () => {
    const store = useDownloadStore();

    store.setWindowsArch("arm64");

    expect(store.os).toBe("windows");
    expect(store.arch).toBe("arm64");
    expect(store.windowsArch).toBe("arm64");
    expect(store.selectedId).toBe("windows");
  });

  it("preserves a manual Windows architecture while macOS detection is pending", async () => {
    platformMocks.detectPlatform.mockReturnValue("macos");
    const detection = deferred<"x64">();
    platformMocks.detectMacArchFromNavigator.mockReturnValue(detection.promise);
    const store = useDownloadStore();

    const initialization = store.init();
    store.setWindowsArch("arm64");
    detection.resolve("x64");
    await initialization;

    expect(store.os).toBe("windows");
    expect(store.windowsArch).toBe("arm64");
    expect(store.selectedId).toBe("windows");
  });
});
