import { normalizeDocsSiteUrl } from "~/utils/docsUrl";

export default defineEventHandler((event) => {
  const config = useRuntimeConfig();
  const siteUrl = ((config.public.siteUrl as string) || "https://777genius.github.io/agent-teams-ai").replace(/\/+$/, "");
  const docsSiteUrl = normalizeDocsSiteUrl(config.public.docsSiteUrl) || `${siteUrl}/docs/`;

  setHeader(event, "content-type", "text/plain; charset=utf-8");

  return `User-agent: *
Allow: /
Sitemap: ${siteUrl}/sitemap.xml
Sitemap: ${docsSiteUrl}sitemap.xml
`;
});
