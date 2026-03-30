import React from 'react';

// =============================================================================
// Syntax Highlighting (Basic Token-based)
// =============================================================================

// Basic keyword sets for common languages
const KEYWORDS: Record<string, Set<string>> = {
  typescript: new Set([
    'import',
    'export',
    'from',
    'const',
    'let',
    'var',
    'function',
    'class',
    'interface',
    'type',
    'enum',
    'return',
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'break',
    'continue',
    'try',
    'catch',
    'finally',
    'throw',
    'new',
    'this',
    'super',
    'extends',
    'implements',
    'async',
    'await',
    'public',
    'private',
    'protected',
    'static',
    'readonly',
    'abstract',
    'as',
    'typeof',
    'instanceof',
    'in',
    'of',
    'keyof',
    'void',
    'never',
    'unknown',
    'any',
    'null',
    'undefined',
    'true',
    'false',
    'default',
  ]),
  javascript: new Set([
    'import',
    'export',
    'from',
    'const',
    'let',
    'var',
    'function',
    'class',
    'return',
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'break',
    'continue',
    'try',
    'catch',
    'finally',
    'throw',
    'new',
    'this',
    'super',
    'extends',
    'async',
    'await',
    'typeof',
    'instanceof',
    'in',
    'of',
    'void',
    'null',
    'undefined',
    'true',
    'false',
    'default',
  ]),
  python: new Set([
    'import',
    'from',
    'as',
    'def',
    'class',
    'return',
    'if',
    'elif',
    'else',
    'for',
    'while',
    'break',
    'continue',
    'try',
    'except',
    'finally',
    'raise',
    'with',
    'as',
    'pass',
    'lambda',
    'yield',
    'global',
    'nonlocal',
    'assert',
    'and',
    'or',
    'not',
    'in',
    'is',
    'True',
    'False',
    'None',
    'async',
    'await',
    'self',
    'cls',
  ]),
  rust: new Set([
    'fn',
    'let',
    'mut',
    'const',
    'static',
    'struct',
    'enum',
    'impl',
    'trait',
    'pub',
    'mod',
    'use',
    'crate',
    'self',
    'super',
    'where',
    'for',
    'loop',
    'while',
    'if',
    'else',
    'match',
    'return',
    'break',
    'continue',
    'move',
    'ref',
    'as',
    'in',
    'unsafe',
    'async',
    'await',
    'dyn',
    'true',
    'false',
    'type',
    'extern',
  ]),
  go: new Set([
    'package',
    'import',
    'func',
    'var',
    'const',
    'type',
    'struct',
    'interface',
    'map',
    'chan',
    'go',
    'defer',
    'return',
    'if',
    'else',
    'for',
    'range',
    'switch',
    'case',
    'default',
    'break',
    'continue',
    'fallthrough',
    'select',
    'nil',
    'true',
    'false',
  ]),
  r: new Set([
    'if',
    'else',
    'for',
    'while',
    'repeat',
    'function',
    'return',
    'next',
    'break',
    'in',
    'library',
    'require',
    'source',
    'TRUE',
    'FALSE',
    'NULL',
    'NA',
    'Inf',
    'NaN',
    'NA_integer_',
    'NA_real_',
    'NA_complex_',
    'NA_character_',
  ]),
  ruby: new Set([
    'def',
    'class',
    'module',
    'end',
    'do',
    'if',
    'elsif',
    'else',
    'unless',
    'while',
    'until',
    'for',
    'in',
    'begin',
    'rescue',
    'ensure',
    'raise',
    'return',
    'yield',
    'block_given?',
    'require',
    'require_relative',
    'include',
    'extend',
    'attr_accessor',
    'attr_reader',
    'attr_writer',
    'self',
    'super',
    'nil',
    'true',
    'false',
    'and',
    'or',
    'not',
    'then',
    'when',
    'case',
    'lambda',
    'proc',
    'puts',
    'print',
  ]),
  php: new Set([
    'function',
    'class',
    'interface',
    'trait',
    'extends',
    'implements',
    'namespace',
    'use',
    'public',
    'private',
    'protected',
    'static',
    'abstract',
    'final',
    'const',
    'var',
    'new',
    'return',
    'if',
    'elseif',
    'else',
    'for',
    'foreach',
    'while',
    'do',
    'switch',
    'case',
    'break',
    'continue',
    'default',
    'try',
    'catch',
    'finally',
    'throw',
    'as',
    'echo',
    'print',
    'require',
    'require_once',
    'include',
    'include_once',
    'true',
    'false',
    'null',
    'array',
    'isset',
    'unset',
    'empty',
    'self',
    'this',
  ]),
  sql: new Set([
    'SELECT',
    'FROM',
    'WHERE',
    'INSERT',
    'INTO',
    'UPDATE',
    'SET',
    'DELETE',
    'CREATE',
    'ALTER',
    'DROP',
    'TABLE',
    'INDEX',
    'VIEW',
    'DATABASE',
    'JOIN',
    'INNER',
    'LEFT',
    'RIGHT',
    'OUTER',
    'FULL',
    'CROSS',
    'ON',
    'AND',
    'OR',
    'NOT',
    'IN',
    'EXISTS',
    'BETWEEN',
    'LIKE',
    'IS',
    'NULL',
    'AS',
    'ORDER',
    'BY',
    'GROUP',
    'HAVING',
    'LIMIT',
    'OFFSET',
    'UNION',
    'ALL',
    'DISTINCT',
    'COUNT',
    'SUM',
    'AVG',
    'MIN',
    'MAX',
    'CASE',
    'WHEN',
    'THEN',
    'ELSE',
    'END',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'TRANSACTION',
    'PRIMARY',
    'KEY',
    'FOREIGN',
    'REFERENCES',
    'CONSTRAINT',
    'DEFAULT',
    'VALUES',
    'TRUE',
    'FALSE',
    'INTEGER',
    'VARCHAR',
    'TEXT',
    'BOOLEAN',
    'DATE',
    'TIMESTAMP',
  ]),
};

// Extend tsx/jsx to use typescript/javascript keywords
KEYWORDS.tsx = KEYWORDS.typescript;
KEYWORDS.jsx = KEYWORDS.javascript;

/**
 * Very basic tokenization for syntax highlighting.
 * This is a simple approach without a full parser.
 */
export function highlightLine(line: string, language: string): React.ReactNode[] {
  const keywords = KEYWORDS[language] || new Set();

  // If no highlighting support, return plain text as single-element array
  if (keywords.size === 0 && !['json', 'css', 'html', 'bash', 'markdown'].includes(language)) {
    return [line];
  }

  const segments: React.ReactNode[] = [];
  let currentPos = 0;
  const lineLength = line.length;

  while (currentPos < lineLength) {
    const remaining = line.slice(currentPos);

    // Check for string (double quote)
    if (remaining.startsWith('"')) {
      const endQuote = remaining.indexOf('"', 1);
      if (endQuote !== -1) {
        const str = remaining.slice(0, endQuote + 1);
        segments.push(
          React.createElement(
            'span',
            { key: currentPos, style: { color: 'var(--syntax-string)' } },
            str
          )
        );
        currentPos += str.length;
        continue;
      }
    }

    // Check for string (single quote)
    if (remaining.startsWith("'")) {
      const endQuote = remaining.indexOf("'", 1);
      if (endQuote !== -1) {
        const str = remaining.slice(0, endQuote + 1);
        segments.push(
          React.createElement(
            'span',
            { key: currentPos, style: { color: 'var(--syntax-string)' } },
            str
          )
        );
        currentPos += str.length;
        continue;
      }
    }

    // Check for template literal (backtick)
    if (remaining.startsWith('`')) {
      const endQuote = remaining.indexOf('`', 1);
      if (endQuote !== -1) {
        const str = remaining.slice(0, endQuote + 1);
        segments.push(
          React.createElement(
            'span',
            { key: currentPos, style: { color: 'var(--syntax-string)' } },
            str
          )
        );
        currentPos += str.length;
        continue;
      }
    }

    // Check for comment (// style)
    if (remaining.startsWith('//')) {
      segments.push(
        React.createElement(
          'span',
          { key: currentPos, style: { color: 'var(--syntax-comment)', fontStyle: 'italic' } },
          remaining
        )
      );
      break;
    }

    // Check for comment (# style for Python/Shell/R/Ruby/PHP)
    if (
      (language === 'python' || language === 'bash' || language === 'r' || language === 'ruby' || language === 'php') &&
      remaining.startsWith('#')
    ) {
      segments.push(
        React.createElement(
          'span',
          { key: currentPos, style: { color: 'var(--syntax-comment)', fontStyle: 'italic' } },
          remaining
        )
      );
      break;
    }

    // Check for comment (-- style for SQL)
    if (language === 'sql' && remaining.startsWith('--')) {
      segments.push(
        React.createElement(
          'span',
          { key: currentPos, style: { color: 'var(--syntax-comment)', fontStyle: 'italic' } },
          remaining
        )
      );
      break;
    }

    // Check for numbers
    const numberMatch = /^(\d+\.?\d*)/.exec(remaining);
    if (numberMatch && (currentPos === 0 || /\W/.test(line[currentPos - 1]))) {
      segments.push(
        React.createElement(
          'span',
          { key: currentPos, style: { color: 'var(--syntax-number)' } },
          numberMatch[1]
        )
      );
      currentPos += numberMatch[1].length;
      continue;
    }

    // Check for keywords and identifiers
    const wordMatch = /^([a-zA-Z_$][a-zA-Z0-9_$]*)/.exec(remaining);
    if (wordMatch) {
      const word = wordMatch[1];
      // SQL keywords are case-insensitive
      if (keywords.has(word) || (language === 'sql' && keywords.has(word.toUpperCase()))) {
        segments.push(
          React.createElement(
            'span',
            { key: currentPos, style: { color: 'var(--syntax-keyword)', fontWeight: 500 } },
            word
          )
        );
      } else if ((word[0]?.toUpperCase() ?? '') === word[0] && word.length > 1) {
        // Likely a type/class name
        segments.push(
          React.createElement(
            'span',
            { key: currentPos, style: { color: 'var(--syntax-type)' } },
            word
          )
        );
      } else {
        segments.push(word);
      }
      currentPos += word.length;
      continue;
    }

    // Check for operators and punctuation
    const opMatch = /^([=<>!+\-*/%&|^~?:;,.{}()[\]])/.exec(remaining);
    if (opMatch) {
      segments.push(
        React.createElement(
          'span',
          { key: currentPos, style: { color: 'var(--syntax-operator)' } },
          opMatch[1]
        )
      );
      currentPos += 1;
      continue;
    }

    // Default: just add the character
    segments.push(remaining[0]);
    currentPos += 1;
  }

  return segments;
}
