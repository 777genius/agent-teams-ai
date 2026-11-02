import type { PageData } from "vitepress";

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

/** Apply per-page canonical metadata for clean routes and directory indexes. */
export function addPageSeoMetadata(pageData: PageData, docsUrl: string): void {
  const path = pageData.relativePath
    .replace(/(^|\/)index\.md$/, "$1")
    .replace(/\.md$/, "");
  const canonicalUrl = new URL(path, docsUrl).href;
  pageData.frontmatter.head ??= [];
  pageData.frontmatter.head.push(
    ["link", { rel: "canonical", href: canonicalUrl }],
    ["meta", { property: "og:url", content: canonicalUrl }]
  );
}
