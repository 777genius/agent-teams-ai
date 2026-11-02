import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Inspect the actual static output, not source-only helpers. The same generated
// docs are served on the standalone docs host and the GitHub Pages /docs/ mirror.
const outDir = resolve(process.cwd(), ".output/public");
const docsDir = join(outDir, "docs");
const landingUrl = (
  process.env.NUXT_PUBLIC_LANDING_SITE_URL ||
  process.env.NUXT_PUBLIC_SITE_URL ||
  "https://agentteams.live"
).replace(/\/+$/, "");
const docsUrl = (
  process.env.VITEPRESS_SITE_URL ||
  process.env.AGENT_TEAMS_DOCS_SITE_URL ||
  process.env.NUXT_PUBLIC_DOCS_SITE_URL ||
  `${landingUrl}/docs/`
).replace(/\/?$/, "/");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filename = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(filename);
    return entry.isFile() && entry.name.endsWith(".html") ? [filename] : [];
  });
}

function attr(tag: string, name: string): string | null {
  return tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i"))?.[1] ?? null;
}

function tags(html: string, tagName: string): string[] {
  return [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, "gi"))].map((match) => match[0]);
}

function docsRouteFromHtml(filename: string): string {
  return filename.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "");
}

// Verify the URL algorithm independently for both production deployment shapes.
for (const host of ["https://docs.agentteams.live/", "https://example.github.io/agent-teams-ai/docs/"]) {
  assert.equal(new URL(docsRouteFromHtml("index.html"), host).href, host);
  assert.equal(new URL(docsRouteFromHtml("developers/index.html"), host).href, `${host}developers/`);
  assert.equal(new URL(docsRouteFromHtml("ru/guide/quickstart.html"), host).href, `${host}ru/guide/quickstart`);
}

const htmlPaths = htmlFiles(docsDir);
assert(htmlPaths.length > 5, "Expected a nonempty VitePress docs build");

let checked = 0;
for (const file of htmlPaths) {
  const name = relative(docsDir, file).replaceAll("\\", "/");
  if (name === "404.html") continue;
  const expected = new URL(docsRouteFromHtml(name), docsUrl).href;
  const html = read(file);
  const canonical = tags(html, "link").filter((tag) => attr(tag, "rel") === "canonical");
  const ogUrl = tags(html, "meta").filter((tag) => attr(tag, "property") === "og:url");
  assert.equal(canonical.length, 1, `${name}: expected one canonical link`);
  if (ogUrl.length !== 1) {
    const headMeta = tags(html, "meta").filter((tag) => /og:|url|description/.test(tag));
    console.error(`${name}: candidate metadata: ${JSON.stringify(headMeta.slice(0, 12))}`);
    console.error(`${name}: raw og:url present: ${html.includes("og:url")}`);
    console.error(`${name}: canonical: ${JSON.stringify(canonical)}`);
  }
  assert.equal(ogUrl.length, 1, `${name}: expected one og:url`);
  assert.equal(attr(canonical[0], "href"), expected, `${name}: wrong canonical`);
  assert.equal(attr(ogUrl[0], "content"), expected, `${name}: wrong og:url`);
  checked++;
}

// Critical pages must exist in the generated docs, not merely as Markdown.
for (const page of [
  "index.html",
  "developers/index.html",
  "guide/installation.html",
  "guide/connect-external-agent.html",
  "ru/guide/installation.html",
]) {
  assert(htmlPaths.some((file) => relative(docsDir, file).replaceAll("\\", "/") === page), `Missing docs page: ${page}`);
}

const guide = read(join(docsDir, "guide/connect-external-agent.html"));
assert(guide.includes("app_get_connection_info"), "External agent guide must explain app identity verification");
assert(guide.includes("Cloud-only agent"), "External agent guide must disclose local-only access");

const llms = read(join(outDir, "llms.txt"));
assert(llms.includes(`${docsUrl}guide/connect-external-agent`), "Landing llms.txt lacks external-agent instructions");
assert(llms.includes("auth.md"), "Landing llms.txt lacks authentication guidance");
assert(read(join(docsDir, "llms.txt")).trim().length > 30, "Docs llms.txt is missing or empty");
const auth = read(join(outDir, "auth.md"));
assert(auth.includes("No Agent Teams account"), "Auth guidance must explain account-free installation");
assert(auth.includes("local"), "Auth guidance must describe the local integration");

const home = read(join(outDir, "index.html"));
const jsonLd = [...home.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((match) => attr(match[1], "type") === "application/ld+json")
  .map((match) => JSON.parse(match[2]));
const schemaEntries = jsonLd.flatMap((value) => (Array.isArray(value) ? value : [value]));
const software = schemaEntries.find((item) => item?.["@type"] === "SoftwareApplication");
assert(software, "SSR homepage must publish SoftwareApplication JSON-LD");
assert.equal(String(software.offers?.price), "0", "Agent Teams app must advertise free pricing");
assert.equal(software.offers?.priceCurrency, "USD");
assert(software.softwareVersion !== "latest", "Do not publish a fake software version");

console.log(`Agent discovery SSG E2E passed: ${checked} docs HTML pages, llms, auth and product JSON-LD`);
