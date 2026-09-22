export const useGithubRepo = () => {
  const config = useRuntimeConfig();
  const githubRepo = computed(
    () => (config.public.githubRepo as string) || '777genius/agent-teams-ai',
  );
  const repoUrl = computed(() => `https://github.com/${githubRepo.value}`);
  const releasesUrl = computed(
    () => (config.public.githubReleasesUrl as string) || `${repoUrl.value}/releases`,
  );
  const latestReleaseUrl = computed(() => `${releasesUrl.value}/latest`);
  const issuesUrl = computed(() => `${repoUrl.value}/issues`);
  const releaseDownloadUrl = (assetName: string) =>
    `${latestReleaseUrl.value}/download/${assetName}`;

  return {
    githubRepo,
    repoUrl,
    releasesUrl,
    latestReleaseUrl,
    issuesUrl,
    releaseDownloadUrl,
  };
};
