import type { HeadConfig } from "vitepress";

export const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export const normalizeBase = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "/";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}/`;
};

export const withTrailingSlash = (value: string) => `${trimTrailingSlash(value)}/`;

export const rewriteDownloadLinks = (html: string, publicBaseUrl: string) =>
  html.replace(/href="\/(?:([a-z]{2})\/)?download\/"/g, (_match, locale: string | undefined) =>
    `href="${publicBaseUrl}${locale ? `${locale}/` : ""}download/"`
  );

/** Emit canonical tags for the real static URL (not the site-wide docs home). */
export function buildPageSeoHead(page: string, docsUrl: string): HeadConfig[] {
  const path = page.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "");
  const canonicalUrl = new URL(path, docsUrl).href;
  return [
    ["link", { rel: "canonical", href: canonicalUrl }],
    ["meta", { property: "og:url", content: canonicalUrl }]
  ];
}
