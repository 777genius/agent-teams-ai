import type { DownloadArch, DownloadOs } from "~/data/downloads";

// --- Типы GitHub API ---

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type GitHubRelease = {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  assets: ReleaseAsset[];
};

// --- Типы нашего API ---

type Variant = { url: string | null; platformKey: string | null; version: string | null };

type DownloadsApiResponse = {
  ok: boolean;
  source: "github-releases";
  fetchedAt: string;
  version: string | null;
  notes: string | null;
  pubDate: string | null;
  variants: {
    macos: { arm64: Variant; x64: Variant; universal: Variant };
    windows: { x64: Variant };
    linux: { appimage: Variant; deb: Variant };
  };
};

type ResolveResult = { url: string; version: string | null } | null;

// --- Парсинг GitHub Release → наш формат ---

const CACHE_KEY = "cat_releases";
const CACHE_TTL = 10 * 60 * 1000; // 10 минут

const emptyVariant: Variant = { url: null, platformKey: null, version: null };

function findAsset(assets: ReleaseAsset[], pattern: RegExp): ReleaseAsset | null {
  return assets.find((a) => pattern.test(a.name)) || null;
}

function toVariant(asset: ReleaseAsset | null, version: string | null): Variant {
  if (!asset) return { ...emptyVariant };
  return { url: asset.browser_download_url, platformKey: asset.name, version };
}

function parseGitHubRelease(release: GitHubRelease): DownloadsApiResponse {
  const version = release.tag_name?.replace(/^v/, "") || null;
  const assets = (release.assets || []).filter(
    (a) => !a.name.endsWith(".sig") && !a.name.endsWith(".json") && !a.name.endsWith(".tar.gz")
  );

  return {
    ok: assets.length > 0,
    source: "github-releases",
    fetchedAt: new Date().toISOString(),
    version,
    notes: release.body || null,
    pubDate: release.published_at || null,
    variants: {
      macos: {
        arm64: toVariant(findAsset(assets, /[-_]arm64\.dmg$/i), version),
        x64: toVariant(findAsset(assets, /[-_]x64\.dmg$/i), version),
        universal: { ...emptyVariant },
      },
      windows: {
        x64: toVariant(
          findAsset(assets, /[-_]Setup\.exe$/i) || findAsset(assets, /\.exe$/i) || findAsset(assets, /\.msi$/i),
          version
        ),
      },
      linux: {
        appimage: toVariant(findAsset(assets, /\.AppImage$/i), version),
        deb: toVariant(findAsset(assets, /\.deb$/i), version),
      },
    },
  };
}

// --- sessionStorage кеш ---

function readCache(): DownloadsApiResponse | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(data: DownloadsApiResponse): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    // sessionStorage может быть недоступен (private mode и т.д.)
  }
}

// --- Composable ---

export const useReleaseDownloads = () => {
  const config = useRuntimeConfig();
  const githubRepo = (config.public.githubRepo as string) || "777genius/agent-teams-ai";

  const fallbackUrl =
    (config.public.githubReleasesUrl as string) ||
    `https://github.com/${githubRepo}/releases`;

  // useAsyncData дедуплицирует запросы по ключу — все компоненты шарят один результат
  const { data, pending, error } = useAsyncData<DownloadsApiResponse>("releases", async () => {
    const cached = readCache();
    if (cached) return cached;

    const release = await $fetch<GitHubRelease>(
      `https://api.github.com/repos/${githubRepo}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github+json" },
      }
    );

    const parsed = parseGitHubRelease(release);
    writeCache(parsed);
    return parsed;
  }, {
    server: false,
    lazy: true,
  });

  const resolve = (os: DownloadOs, arch: DownloadArch | "unknown"): ResolveResult => {
    const api = data.value;
    if (!api?.ok) return null;

    if (os === "windows") {
      const v = api.variants.windows.x64;
      return v.url ? { url: v.url, version: v.version || api.version } : null;
    }

    if (os === "linux") {
      const v = api.variants.linux.appimage.url ? api.variants.linux.appimage : api.variants.linux.deb;
      return v.url ? { url: v.url, version: v.version || api.version } : null;
    }

    // macOS: сначала universal, потом по архитектуре
    if (os === "macos") {
      const universal = api.variants.macos.universal;
      if (universal.url) return { url: universal.url, version: universal.version || api.version };

      if (arch === "arm64" || arch === "x64") {
        const byArch = arch === "arm64" ? api.variants.macos.arm64 : api.variants.macos.x64;
        if (byArch.url) return { url: byArch.url, version: byArch.version || api.version };
      }

      const any = api.variants.macos.arm64.url ? api.variants.macos.arm64 : api.variants.macos.x64;
      return any.url ? { url: any.url, version: any.version || api.version } : null;
    }

    return null;
  };

  const resolveUrlOrFallback = (os: DownloadOs, arch: DownloadArch | "unknown"): string => {
    return resolve(os, arch)?.url || fallbackUrl;
  };

  return { data, pending, error, fallbackUrl, resolve, resolveUrlOrFallback };
};
