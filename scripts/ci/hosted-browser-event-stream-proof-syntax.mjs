import { spawnSync } from 'node:child_process';

const SIMPLE_STRING_ESCAPES = new Map([
  ['0', '\0'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
]);

/**
 * Parse an emitted module with Node's module grammar, without evaluating it.
 * `--check` reads stdin and never instantiates, links, or executes the module.
 */
export function hasValidHostedJavaScriptModuleSyntax(source) {
  if (typeof source !== 'string') return false;
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    encoding: 'utf8',
    input: source,
    maxBuffer: 1024 * 1024,
    timeout: 5_000,
  });
  return result.error === undefined && result.status === 0;
}

function readString(source, start) {
  const quote = source[start];
  let value = '';
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === quote) return { end: cursor + 1, value };
    if (character === '\\') {
      const next = source[cursor + 1];
      if (next === undefined) return null;
      const simpleEscape = SIMPLE_STRING_ESCAPES.get(next);
      if (simpleEscape !== undefined) {
        value += simpleEscape;
        cursor += 1;
        continue;
      }
      if (next === '\n' || next === '\r') {
        cursor += next === '\r' && source[cursor + 2] === '\n' ? 2 : 1;
        continue;
      }
      if (next === 'x') {
        const digits = source.slice(cursor + 2, cursor + 4);
        if (!/^[0-9A-Fa-f]{2}$/u.test(digits)) return null;
        value += String.fromCodePoint(Number.parseInt(digits, 16));
        cursor += 3;
        continue;
      }
      if (next === 'u') {
        if (source[cursor + 2] === '{') {
          const close = source.indexOf('}', cursor + 3);
          if (close < 0) return null;
          const digits = source.slice(cursor + 3, close);
          if (!/^[0-9A-Fa-f]{1,6}$/u.test(digits)) return null;
          const codePoint = Number.parseInt(digits, 16);
          if (codePoint > 0x10ffff) return null;
          value += String.fromCodePoint(codePoint);
          cursor = close;
          continue;
        }
        const digits = source.slice(cursor + 2, cursor + 6);
        if (!/^[0-9A-Fa-f]{4}$/u.test(digits)) return null;
        value += String.fromCodePoint(Number.parseInt(digits, 16));
        cursor += 5;
        continue;
      }
      // Module grammar has already rejected legacy octal escapes. JavaScript's
      // remaining non-escape characters decode to the character itself.
      value += next;
      cursor += 1;
      continue;
    }
    if (character === '\n' || character === '\r') return null;
    value += character;
  }
  return null;
}

function canStartRegularExpression(tokens) {
  const previousToken = tokens[tokens.length - 1];
  if (previousToken && ['string', 'template', 'regex'].includes(previousToken.kind)) {
    return false;
  }
  const previous = tokenValue(tokens, tokens.length - 1);
  const beforePrevious = tokenValue(tokens, tokens.length - 2);
  return (
    previous === undefined ||
    [
      '(',
      '[',
      '{',
      '=',
      ':',
      ',',
      ';',
      '!',
      '?',
      '&',
      '|',
      '^',
      '~',
      '<',
      '>',
      '+',
      '-',
      '*',
      '%',
      'return',
      'case',
      'throw',
      'yield',
      'await',
      'in',
      'instanceof',
    ].includes(previous) ||
    (beforePrevious === '=' && previous === '>')
  );
}

function readRegularExpression(source, start) {
  let inCharacterClass = false;
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === '\n' || character === '\r') return null;
    if (character === '\\') {
      cursor += 1;
      if (cursor >= source.length) return null;
      continue;
    }
    if (character === '[') inCharacterClass = true;
    else if (character === ']') inCharacterClass = false;
    else if (character === '/' && !inCharacterClass) {
      cursor += 1;
      while (/[A-Za-z]/u.test(source[cursor] ?? '')) cursor += 1;
      return cursor;
    }
  }
  return null;
}

function lineCommentEnd(source, start) {
  const end = source.slice(start).search(/[\r\n\u2028\u2029]/u);
  return end < 0 ? source.length : start + end + 1;
}

// Template expressions are deliberately not part of the installer DSL. Walk
// their nesting so an executable import cannot disappear behind an inner `.
// Reject imports in expressions, even inside a string/comment, rather than
// risk mistaking executable source for inert template text.
function readTemplateExpression(source, start) {
  let depth = 1;
  for (let cursor = start; cursor < source.length; ) {
    const character = source[cursor];
    if (character === '"' || character === "'") {
      const string = readString(source, cursor);
      if (string === null) return null;
      cursor = string.end;
      continue;
    }
    if (character === '`') {
      const nested = readTemplate(source, cursor);
      if (nested === null || nested.hasImport) return null;
      cursor = nested.end;
      continue;
    }
    if (character === '/' && source[cursor + 1] === '/') {
      cursor = lineCommentEnd(source, cursor + 2);
      continue;
    }
    if (character === '/' && source[cursor + 1] === '*') {
      const end = source.indexOf('*/', cursor + 2);
      if (end < 0) return null;
      cursor = end + 2;
      continue;
    }
    // Distinguishing division from regular expressions needs the full grammar.
    // Neither form is modeled here; reject the expression instead.
    if (character === '/') return null;
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) {
      return { end: cursor + 1, hasImport: /\bimport\b/u.test(source.slice(start, cursor)) };
    }
    cursor += 1;
  }
  return null;
}

function readTemplate(source, start) {
  let hasImport = false;
  for (let cursor = start + 1; cursor < source.length; ) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === '`') return { end: cursor + 1, hasImport };
    if (source[cursor] === '$' && source[cursor + 1] === '{') {
      const expression = readTemplateExpression(source, cursor + 2);
      if (expression === null) return null;
      hasImport ||= expression.hasImport;
      cursor = expression.end;
      continue;
    }
    cursor += 1;
  }
  return null;
}

/** A deliberately small lexer for the restricted installer language. */
export function tokenizeHostedJavaScript(source) {
  if (!hasValidHostedJavaScriptModuleSyntax(source)) return null;
  const tokens = [];
  for (let cursor = 0; cursor < source.length; ) {
    const character = source[cursor];
    if (/\s/u.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === '/' && source[cursor + 1] === '/') {
      cursor = lineCommentEnd(source, cursor + 2);
      continue;
    }
    if (character === '/' && source[cursor + 1] === '*') {
      const end = source.indexOf('*/', cursor + 2);
      if (end < 0) return null;
      cursor = end + 2;
      continue;
    }
    if (character === '/' && canStartRegularExpression(tokens)) {
      const end = readRegularExpression(source, cursor);
      if (end === null) return null;
      tokens.push(Object.freeze({ kind: 'regex', value: '' }));
      cursor = end;
      continue;
    }
    if (character === '"' || character === "'") {
      const string = readString(source, cursor);
      if (string === null) return null;
      tokens.push(Object.freeze({ kind: 'string', value: string.value }));
      cursor = string.end;
      continue;
    }
    if (character === '`') {
      const template = readTemplate(source, cursor);
      if (template === null || template.hasImport) return null;
      tokens.push(Object.freeze({ kind: 'template', value: '' }));
      cursor = template.end;
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const start = cursor++;
      while (cursor < source.length && /[A-Za-z0-9_$]/u.test(source[cursor])) cursor += 1;
      tokens.push(Object.freeze({ kind: 'word', value: source.slice(start, cursor) }));
      continue;
    }
    // The closure scanner only recognizes top-level static imports. Preserve
    // other valid syntax as inert punctuation; the installer evaluator below
    // still rejects every non-DSL token before accepting installation.
    tokens.push(Object.freeze({ kind: 'punctuation', value: character }));
    cursor += 1;
  }
  return Object.freeze(tokens);
}

export function tokenValue(tokens, index) {
  const token = tokens[index];
  return token?.kind === 'string' || token?.kind === 'template' || token?.kind === 'regex'
    ? undefined
    : token?.value;
}

export function consumeBalanced(tokens, start, open, close) {
  if (tokenValue(tokens, start) !== open) return -1;
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokenValue(tokens, index) === open) depth += 1;
    if (tokenValue(tokens, index) === close && --depth === 0) return index;
  }
  return -1;
}

export function findHostedStatementEnd(tokens, start) {
  let depth = 0;
  for (let cursor = start; cursor < tokens.length; cursor += 1) {
    const token = tokenValue(tokens, cursor);
    if (['{', '(', '['].includes(token)) depth += 1;
    if (['}', ')', ']'].includes(token)) depth -= 1;
    if (depth < 0) return -1;
    if (depth === 0 && token === ';') return cursor;
  }
  return -1;
}
