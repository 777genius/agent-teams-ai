import { ANNOUNCEMENTS_ORIGIN } from '../contracts';

import type { Root, RootContent } from 'hast';

/** Remote content never gets a project base directory or an internal-link renderer. */
export function announcementUrl(value: string, bodyUrl: string, image = false): string | null {
  if (
    !value ||
    value !== value.trim() ||
    [...value].some((char) => char.charCodeAt(0) <= 32) ||
    value.includes('\\') ||
    value.startsWith('//')
  )
    return null;
  if (!image && value.startsWith('#')) return value;
  try {
    const base = new URL(bodyUrl);
    const url = new URL(value, base);
    if (url.username || url.password) return null;
    if (!image) return url.protocol === 'https:' && !url.port ? url.href : null;
    const fixture =
      import.meta.env.DEV && base.protocol === 'http:' && base.hostname === '127.0.0.1';
    if (base.origin !== ANNOUNCEMENTS_ORIGIN && !fixture) return null;
    if (
      url.origin !== base.origin ||
      !/^\/announcements\/content\/[a-z0-9-]+\/[a-f0-9]+\/body\.md$/.test(base.pathname)
    )
      return null;
    const assetRoot = new URL('assets/', base).pathname;
    if (!url.pathname.startsWith(assetRoot) || /%2f|%5c|%2e/i.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Stable local heading fragments, scoped to this article rather than app navigation. */
export function announcementHeadingIds() {
  return (tree: Root): void => {
    const used = new Map<string, number>();
    const text = (node: RootContent): string =>
      'value' in node
        ? String(node.value)
        : 'children' in node
          ? node.children.map(text).join('')
          : '';
    const visit = (node: RootContent): void => {
      if (node.type !== 'element') return;
      if (/^h[1-6]$/.test(node.tagName)) {
        const slug =
          text(node)
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, '')
            .replace(/\s+/g, '-') || 'section';
        const count = used.get(slug) ?? 0;
        used.set(slug, count + 1);
        node.children.unshift({
          type: 'element',
          tagName: 'span',
          properties: { id: count ? `${slug}-${count}` : slug },
          children: [],
        });
      }
      node.children.forEach(visit);
    };
    tree.children.forEach(visit);
  };
}
