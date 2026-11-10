import type { DownloadArch, DownloadOs } from '~/data/downloads';
import {
  encodeReleaseCache,
  manifestAssetApiUrl,
  parseReleaseDownloads,
  platformReleaseInfo,
  readGitHubRelease,
  readReleaseCache,
  releaseCacheKey,
  resolveReleaseDownload,
  type DownloadsApiResponse,
} from '~/utils/releaseDownloads';

export const useReleaseDownloads = () => {
  const config = useRuntimeConfig();
  const githubRepo = (config.public.githubRepo as string) || '777genius/agent-teams-ai';
  const cacheKey = releaseCacheKey(githubRepo);
  const fallbackUrl =
    (config.public.githubReleasesUrl as string) || `https://github.com/${githubRepo}/releases`;

  // Repository and schema are part of both keys; all consumers share this request.
  const { data, pending, error } = useAsyncData<DownloadsApiResponse>(
    cacheKey,
    async () => {
      try {
        const cached = readReleaseCache(sessionStorage.getItem(cacheKey), githubRepo);
        if (cached) return cached;
      } catch {
        // Storage may be unavailable in private browsing.
      }
      const raw = await $fetch<unknown>(
        `https://api.github.com/repos/${githubRepo}/releases/latest`,
        {
          headers: { Accept: 'application/vnd.github+json' },
        }
      );
      const release = readGitHubRelease(raw, githubRepo);
      if (!release) throw new Error('Invalid GitHub release metadata');
      const manifestUrl = manifestAssetApiUrl(release, githubRepo);
      let manifest: unknown = null;
      if (manifestUrl) {
        try {
          const text = await $fetch<string>(manifestUrl, {
            headers: { Accept: 'application/octet-stream' },
            responseType: 'text',
            timeout: 4000,
            retry: 0,
          });
          manifest = JSON.parse(text);
        } catch {
          // CORS or unavailable asset bodies leave canonical filenames as evidence.
        }
      }
      const parsed = parseReleaseDownloads(release, githubRepo, manifest);
      try {
        sessionStorage.setItem(cacheKey, encodeReleaseCache(githubRepo, release, manifest));
      } catch {
        // Download resolution does not depend on storage availability.
      }
      return parsed;
    },
    { server: false, lazy: true }
  );

  const resolve = (os: DownloadOs, arch: DownloadArch | 'unknown') =>
    resolveReleaseDownload(data.value, os, arch);
  const platformInfo = (os: DownloadOs, arch: DownloadArch | 'unknown') =>
    arch === 'unknown' || arch === 'universal'
      ? platformReleaseInfo(data.value, os)
      : (resolve(os, arch) ?? { version: null, pubDate: null });
  const resolveUrlOrFallback = (os: DownloadOs, arch: DownloadArch | 'unknown'): string =>
    resolve(os, arch)?.url || fallbackUrl;

  return { data, pending, error, fallbackUrl, resolve, platformInfo, resolveUrlOrFallback };
};
