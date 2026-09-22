import { defaultLocale, getLocalizedPagePath, sitemapPages, supportedLocales } from "~/data/i18n";
import { screenshots } from "~/data/screenshots";

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
  const siteUrl = ((config.public.siteUrl as string) || "https://777genius.github.io/agent-teams-ai").replace(/\/+$/, "");
  const toSiteUrl = (path: string) => `${siteUrl}${path === "/" ? "/" : `/${path.replace(/^\/+/, "")}`}`;
  const ogImagePath = "og-image-agent-teams-v6.png";
  const homeImagePaths = [ogImagePath, ...screenshots.map((screenshot) => screenshot.path)];
  const downloadImagePaths = [ogImagePath, "logo-192.png"];

  setHeader(event, "content-type", "application/xml; charset=utf-8");

  const entries = sitemapPages.flatMap((page) =>
    supportedLocales.map((locale) => ({
      path: getLocalizedPagePath(page, locale.code),
      page
    }))
  );

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${entries
  .map(
    ({ path, page }) => {
      const alternates = supportedLocales
        .map((locale) => {
          const href = toSiteUrl(getLocalizedPagePath(page, locale.code));
          return `    <xhtml:link rel="alternate" hreflang="${escapeXml(locale.iso)}" href="${escapeXml(href)}" />`;
        })
        .join("\n");
      const imagePaths = page === "/" ? homeImagePaths : downloadImagePaths;
      const images = imagePaths
        .map((imagePath) => `    <image:image>\n      <image:loc>${escapeXml(toSiteUrl(imagePath))}</image:loc>\n    </image:image>`)
        .join("\n");
      const defaultHref = toSiteUrl(getLocalizedPagePath(page, defaultLocale));
      return `  <url>\n    <loc>${escapeXml(toSiteUrl(path))}</loc>\n${alternates}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(defaultHref)}" />\n${images}\n    <lastmod>${buildDate}</lastmod>\n  </url>`;
    }
  )
  .join("\n")}
</urlset>
`;

  return body;
});
