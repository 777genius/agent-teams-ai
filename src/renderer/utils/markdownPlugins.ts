/**
 * Rehype plugins for markdown rendering (used with react-markdown).
 *
 * - rehype-raw: parse and render inline HTML in markdown
 * - rehype-highlight: syntax highlighting for code blocks
 */

import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';

/** Full plugin chain: raw HTML + syntax highlighting */
export const REHYPE_PLUGINS = [rehypeRaw, rehypeHighlight];

/** Lightweight chain: raw HTML only (used when highlighting is disabled for large content) */
export const REHYPE_PLUGINS_NO_HIGHLIGHT = [rehypeRaw];
