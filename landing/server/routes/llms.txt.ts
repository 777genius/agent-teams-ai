import { defaultLocale, getLocalizedPagePath, sitemapPages, supportedLocales } from "~/data/i18n";
import { normalizeDocsSiteUrl } from "~/utils/docsUrl";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export default defineEventHandler((event) => {
  const config = useRuntimeConfig();
  const siteUrl = trimTrailingSlash(
    (config.public.siteUrl as string) || "https://777genius.github.io/agent-teams-ai"
  );
  const githubRepo = (config.public.githubRepo as string) || "777genius/agent-teams-ai";
  const githubUrl = `https://github.com/${githubRepo}`;
  const releasesUrl = `${githubUrl}/releases`;
  const toSiteUrl = (path: string) => `${siteUrl}${path === "/" ? "/" : `/${path.replace(/^\/+/, "")}`}`;
  const docsSiteUrl = normalizeDocsSiteUrl(config.public.docsSiteUrl) || toSiteUrl("/docs/");

  setHeader(event, "content-type", "text/plain; charset=utf-8");

  const localizedPages = sitemapPages
    .flatMap((page) =>
      supportedLocales.map((locale) => {
        const path = getLocalizedPagePath(page, locale.code);
        const label = page === "/" ? "Landing" : "Download";
        return `- ${label} (${locale.iso}): ${toSiteUrl(path)}`;
      })
    )
    .join("\n");

  return `# Agent Teams

> Agent Teams is a free, open-source local desktop app for orchestrating AI agent teams across Claude, Codex, and OpenCode. It provides a live kanban board, agent-to-agent messaging, task logs, code review, downloads for macOS, Windows, and Linux, and local-first control.

## Primary URLs

- Homepage (${defaultLocale}): ${toSiteUrl("/")}
- Download: ${toSiteUrl("/download")}
- Documentation: ${docsSiteUrl}
- Documentation llms.txt: ${docsSiteUrl}llms.txt
- GitHub repository: ${githubUrl}
- Releases: ${releasesUrl}
- Sitemap: ${toSiteUrl("/sitemap.xml")}

## Localized landing pages

${localizedPages}

## Useful context

- The app itself is free and open source.
- Provider/runtime access is supplied by the user through supported local runtimes or provider accounts.
- The product is local-first: coordination state and project workflows are designed to run on the user's machine.
- Key workflows: create an agent team, assign or let agents create tasks, watch progress on a kanban board, inspect task logs, and review code changes.
`;
});
