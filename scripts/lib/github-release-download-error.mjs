export function formatGitHubReleaseDownloadError({
  kind,
  response,
  repository,
  releaseTag,
  assetName,
  url,
  lockPath,
  notFoundHint,
}) {
  const statusText = response.statusText ? ` ${response.statusText}` : '';
  const lines = [`Failed to download ${kind}: ${response.status}${statusText}`];

  if (repository || releaseTag) {
    lines.push(`Release: ${repository ?? '<unknown>'}@${releaseTag ?? '<unknown>'}`);
  }
  if (assetName) {
    lines.push(`Asset: ${assetName}`);
  }
  if (url) {
    lines.push(`URL: ${url}`);
  }
  if (lockPath) {
    lines.push(`Lock file: ${lockPath}`);
  }

  if (response.status === 404) {
    lines.push(
      notFoundHint ??
        '404 usually means the release or asset does not exist, is private, or is still a draft.'
    );
  } else if (response.status === 401 || response.status === 403) {
    lines.push('Check GitHub permissions or GH_TOKEN access for this release asset.');
  }

  return lines.join('\n');
}
