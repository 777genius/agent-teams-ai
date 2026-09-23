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
