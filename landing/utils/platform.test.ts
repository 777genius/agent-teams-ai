import { describe, expect, it } from "vitest";
import {
  detectMacArch,
  detectMacArchFromClientHints,
  detectMacArchFromRenderer,
  detectPlatform,
} from "./platform";

const macSafariUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

describe("landing platform detection", () => {
  it("uses UA Client Hints platform when available", () => {
    expect(detectPlatform({
      userAgent: "Mozilla/5.0",
      userAgentData: { platform: "macOS" },
    })).toBe("macos");
    expect(detectPlatform({
      userAgent: "Mozilla/5.0",
      userAgentData: { platform: "Windows" },
    })).toBe("windows");
    expect(detectPlatform({
      userAgent: "Mozilla/5.0",
      userAgentData: { platform: "Linux" },
    })).toBe("linux");
  });

  it("detects common desktop OS signals", () => {
    expect(detectPlatform({
      userAgent: macSafariUserAgent,
      platform: "MacIntel",
      maxTouchPoints: 0,
    })).toBe("macos");
    expect(detectPlatform({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
      platform: "Win32",
    })).toBe("windows");
    expect(detectPlatform({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
      platform: "Linux x86_64",
    })).toBe("linux");
  });

  it("does not classify mobile, tablet, or ChromeOS devices as desktop downloads", () => {
    expect(detectPlatform({
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36",
      platform: "Linux armv8l",
    })).toBe("unknown");
    expect(detectPlatform({
      userAgent: "Mozilla/5.0",
      userAgentData: { mobile: true, platform: "Linux" },
    })).toBe("unknown");
    expect(detectPlatform({
      userAgent: "Mozilla/5.0 (X11; CrOS x86_64 16093.0.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
      platform: "Linux x86_64",
    })).toBe("unknown");
    expect(detectPlatform({
      userAgent: macSafariUserAgent,
      platform: "MacIntel",
      maxTouchPoints: 5,
    })).toBe("unknown");
    expect(detectPlatform({
      userAgent: "Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; RM-1152) AppleWebKit/537.36 Edge/15.15254",
      platform: "Win32",
    })).toBe("unknown");
  });

  it("does not treat non-Linux X11 platforms as Linux downloads", () => {
    expect(detectPlatform({
      userAgent: "Mozilla/5.0 (X11; FreeBSD amd64; rv:128.0) Gecko/20100101 Firefox/128.0",
      platform: "FreeBSD amd64",
    })).toBe("unknown");
    expect(detectPlatform({
      userAgent: "Mozilla/5.0 (X11; OpenBSD amd64; rv:128.0) Gecko/20100101 Firefox/128.0",
      platform: "OpenBSD amd64",
    })).toBe("unknown");
  });

  it("maps high-entropy architecture hints without trusting the macOS UA Intel token", async () => {
    await expect(detectMacArchFromClientHints({
      getHighEntropyValues: async () => ({ architecture: "arm", bitness: "64" }),
    })).resolves.toBe("arm64");
    await expect(detectMacArchFromClientHints({
      getHighEntropyValues: async () => ({ architecture: "x86", bitness: "64" }),
    })).resolves.toBe("x64");
    await expect(detectMacArchFromClientHints({
      getHighEntropyValues: async () => ({ architecture: "x86", bitness: "32" }),
    })).resolves.toBe("unknown");
    expect(detectMacArch(macSafariUserAgent)).toBe("unknown");
  });

  it("uses WebGL renderer strings only when they carry a clear chip signal", () => {
    expect(detectMacArchFromRenderer("ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)")).toBe("arm64");
    expect(detectMacArchFromRenderer("Apple GPU")).toBe("arm64");
    expect(detectMacArchFromRenderer("Intel Iris OpenGL Engine")).toBe("x64");
    expect(detectMacArchFromRenderer("AMD Radeon Pro 5500M OpenGL Engine")).toBe("x64");
    expect(detectMacArchFromRenderer("WebKit WebGL")).toBe("unknown");
  });
});
