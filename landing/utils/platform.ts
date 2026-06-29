import type { PlatformArch, PlatformOs } from "~/types/platform";

type NavigatorUADataLike = {
  mobile?: boolean;
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    architecture?: string;
    bitness?: string;
    platform?: string;
  }>;
};

type PlatformDetectionInput = string | {
  maxTouchPoints?: number;
  platform?: string;
  userAgent?: string;
  userAgentData?: NavigatorUADataLike;
};

const toInputParts = (input: PlatformDetectionInput) => {
  if (typeof input === "string") {
    return {
      maxTouchPoints: 0,
      platform: "",
      userAgent: input,
      userAgentData: undefined as NavigatorUADataLike | undefined,
    };
  }

  return {
    maxTouchPoints: input.maxTouchPoints ?? 0,
    platform: input.platform ?? "",
    userAgent: input.userAgent ?? "",
    userAgentData: input.userAgentData,
  };
};

const normalizePlatform = (platform: string): PlatformOs => {
  const value = platform.toLowerCase();
  if (value.includes("mac")) return "macos";
  if (value.includes("win")) return "windows";
  if (value === "linux" || /\blinux\b/.test(value)) return "linux";
  return "unknown";
};

const isLikelyNonDesktopDownloadDevice = (
  userAgent: string,
  platform: string,
  maxTouchPoints: number,
  userAgentData?: NavigatorUADataLike,
) => {
  const ua = userAgent.toLowerCase();
  const legacyPlatform = platform.toLowerCase();

  return (
    userAgentData?.mobile === true ||
    /\b(android|iphone|ipad|ipod|mobile|tablet|windows phone|iemobile|windows ce|blackberry|bb10|webos)\b/.test(ua) ||
    (ua.includes("macintosh") && ua.includes("mobile/")) ||
    (legacyPlatform.startsWith("mac") && maxTouchPoints > 1)
  );
};

export const detectPlatform = (input: PlatformDetectionInput): PlatformOs => {
  const { maxTouchPoints, platform, userAgent, userAgentData } = toInputParts(input);
  if (isLikelyNonDesktopDownloadDevice(userAgent, platform, maxTouchPoints, userAgentData)) {
    return "unknown";
  }

  const hintedPlatform = normalizePlatform(userAgentData?.platform ?? "");
  if (hintedPlatform !== "unknown") return hintedPlatform;

  const ua = userAgent.toLowerCase();
  if (ua.includes("cros") || ua.includes("chrome os")) return "unknown";

  const legacyPlatform = normalizePlatform(platform);
  if (legacyPlatform !== "unknown") return legacyPlatform;

  if (ua.includes("windows") || ua.includes("win64") || ua.includes("win32")) return "windows";
  if (ua.includes("macintosh") || ua.includes("mac os x")) return "macos";
  if (ua.includes("linux")) return "linux";
  return "unknown";
};

const normalizeArch = (architecture?: string, bitness?: string): PlatformArch => {
  const arch = (architecture ?? "").toLowerCase();
  const bits = bitness ?? "";

  if (!arch) return "unknown";
  if (arch.includes("arm") || arch.includes("aarch64")) return "arm64";
  if (arch.includes("x86") || arch.includes("x64") || arch.includes("amd64")) {
    return bits === "32" ? "unknown" : "x64";
  }

  return "unknown";
};

export const detectMacArchFromRenderer = (renderer: string): PlatformArch => {
  if (/\bapple\s+(?:m\d|gpu)\b|angle metal renderer:\s*apple/i.test(renderer)) {
    return "arm64";
  }

  if (/\b(intel|amd|ati|radeon|nvidia|geforce|quadro)\b/i.test(renderer)) {
    return "x64";
  }

  return "unknown";
};

const detectMacArchFromWebGl = (): PlatformArch => {
  if (typeof document === "undefined") return "unknown";

  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) return "unknown";

    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (!dbg) return "unknown";

    return detectMacArchFromRenderer(String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? ""));
  } catch {
    return "unknown";
  }
};

export const detectMacArch = (input: PlatformDetectionInput): PlatformArch => {
  const { userAgent } = toInputParts(input);
  const ua = userAgent.toLowerCase();
  if (/\b(arm64|aarch64)\b/.test(ua)) return "arm64";
  if (/\b(x86_64|x64|amd64)\b/.test(ua)) return "x64";

  return detectMacArchFromWebGl();
};

export const detectMacArchFromClientHints = async (
  userAgentData?: NavigatorUADataLike,
): Promise<PlatformArch> => {
  try {
    const values = await userAgentData?.getHighEntropyValues?.(["architecture", "bitness"]);
    return normalizeArch(values?.architecture, values?.bitness);
  } catch {
    return "unknown";
  }
};

export const detectMacArchFromNavigator = async (
  input: PlatformDetectionInput,
): Promise<PlatformArch> => {
  const { userAgentData } = toInputParts(input);
  const hintedArch = await detectMacArchFromClientHints(userAgentData);
  if (hintedArch !== "unknown") return hintedArch;

  return detectMacArch(input);
};
