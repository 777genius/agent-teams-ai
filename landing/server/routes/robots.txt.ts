export default defineEventHandler((event) => {
  const config = useRuntimeConfig();
  const siteUrl = (config.public.siteUrl as string) || "https://claude-agent-teams.dev";

  setHeader(event, "content-type", "text/plain; charset=utf-8");

  return `User-agent: *
Allow: /
Sitemap: ${siteUrl}/sitemap.xml
`;
});
