/**
 * Rehype plugins for markdown rendering (used with react-markdown).
 * Rehype runs after remark; rehype-highlight adds syntax highlighting to code blocks.
 */

import rehypeHighlight from 'rehype-highlight';

export const REHYPE_PLUGINS = [rehypeHighlight];
