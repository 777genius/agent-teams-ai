import { generateSitemapRoutes } from "~/data/i18n";

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const buildDate = new Date().toISOString().split("T")[0];

export default defineEventHandler((event) => {
  const config = useRuntimeConfig();
  const siteUrl = (config.public.siteUrl as string) || "https://claude-agent-teams.dev";

  setHeader(event, "content-type", "application/xml; charset=utf-8");

  const routes = generateSitemapRoutes();
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes
  .map(
    (path) =>
      `  <url>\n    <loc>${escapeXml(`${siteUrl}${path}`)}</loc>\n    <lastmod>${buildDate}</lastmod>\n  </url>`
  )
  .join("\n")}
</urlset>
`;

  return body;
});
