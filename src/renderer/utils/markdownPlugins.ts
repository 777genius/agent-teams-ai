/**
 * Rehype plugins for markdown rendering (used with react-markdown).
 *
 * - rehype-raw: parse and render inline HTML in markdown
 * - rehype-sanitize: strip dangerous HTML (scripts, event handlers, etc.)
 * - rehype-highlight: syntax highlighting for code blocks
 *
 * Plugin order matters: raw parses inline HTML into hast nodes, sanitize
 * removes dangerous content, then highlight adds its own safe classes.
 */

import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

import type { Options as SanitizeSchema } from 'rehype-sanitize';
import type { PluggableList } from 'unified';

/**
 * Sanitization schema extending the GitHub-based default.
 *
 * The default already allows: details, summary, kbd, sub, sup, del, ins,
 * tables, headings, code, pre, img, a, lists, etc.
 *
 * We extend it with additional tags Claude commonly uses in markdown output.
 */
const sanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'mark', // text highlighting
    'abbr', // abbreviations
    'u', // underline
    'figure', // figures
    'figcaption', // figure captions
  ],
  attributes: {
    ...defaultSchema.attributes,
    // Allow title on abbr (for tooltip definitions)
    abbr: [...(defaultSchema.attributes?.abbr ?? []), 'title'],
  },
  protocols: {
    ...defaultSchema.protocols,
    // Allow internal-only protocols used for mention badges, team badges, and task tooltips
    href: [...(defaultSchema.protocols?.href ?? []), 'mention', 'team', 'task'],
  },
};

/** Full plugin chain: raw HTML → sanitize → syntax highlighting */
export const REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, sanitizeSchema],
  rehypeHighlight,
];

/** Lightweight chain: raw HTML → sanitize only (used when highlighting is disabled for large content) */
export const REHYPE_PLUGINS_NO_HIGHLIGHT: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, sanitizeSchema],
];
