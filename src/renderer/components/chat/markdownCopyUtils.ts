import React from 'react';

/**
 * Extract plain text from rendered markdown children for per-block copy actions.
 */
export function extractTextFromReactNode(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractTextFromReactNode).join('');
  }
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return extractTextFromReactNode(props.children);
  }
  return '';
}
