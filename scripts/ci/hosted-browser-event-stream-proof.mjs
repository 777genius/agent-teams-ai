import { posix } from 'node:path';
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function extractHostedHtmlModuleScriptPaths(html) {
  if (typeof html !== 'string') return null;
  // No HTML parser is available in the runtime image (and this verifier may
  // not add one).  This is a deliberately narrow token stream: unsupported
  // character references or malformed tokens reject the artifact rather than
  // turning text which a browser would keep inert into an entry module.
  const paths = [], rawTextTags = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
  const characterReferences = Object.freeze({ amp: '&', apos: "'", gt: '>', lt: '<', nbsp: '\u00a0', quot: '"' });
  const decodeAttribute = (value) => value.replace(/&(?:#([0-9]+)|#x([0-9A-Fa-f]+)|([A-Za-z][A-Za-z0-9]+));/gu, (match, decimal, hexadecimal, named) => {
    if (decimal !== undefined || hexadecimal !== undefined) {
      const codePoint = Number.parseInt(decimal ?? hexadecimal, decimal === undefined ? 16 : 10);
      return codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? String.fromCodePoint(codePoint) : '\uFFFD';
    }
    return characterReferences[named] ?? match;
  });
  const readTag = (start) => {
    if (html[start] !== '<' || html.startsWith('<!--', start)) return null;
    let cursor = start + 1, closing = false; if (html[cursor] === '/') { closing = true; cursor += 1; }
    const nameStart = cursor;
    if (!/[A-Za-z]/u.test(html[cursor] ?? '')) return null;
    while (cursor < html.length && !/[\t\n\f\r />]/u.test(html[cursor])) cursor += 1;
    const name = html.slice(nameStart, cursor).toLowerCase(); if (!name) return null;
    let quote = '', end = -1;
    for (; cursor < html.length; cursor += 1) { const character = html[cursor]; if (quote) { if (character === quote) quote = ''; continue; } if (character === '"' || character === "'") { quote = character; continue; } if (character === '>') { end = cursor; break; } if (character === '<') return null; }
    if (end < 0 || quote) return null;
    const attributes = new Map(), body = html.slice(nameStart + name.length, end);
    if (!closing) for (const attribute of body.matchAll(/([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)) { const key = attribute[1].toLowerCase(); if (!attributes.has(key)) attributes.set(key, decodeAttribute(attribute[2] ?? attribute[3] ?? attribute[4] ?? '')); }
    return { attributes, closing, end, name };
  };
  const scriptEnd = (from) => {
    let cursor = from, state = 'data';
    const endTag = (at) => {
      if (!html.slice(at, at + 8).toLowerCase().startsWith('</script')) return -1;
      const boundary = html[at + 8] ?? '';
      if (boundary && !/[\t\n\f\r />]/u.test(boundary)) return -1;
      const end = html.indexOf('>', at + 8);
      return end < 0 ? -2 : end + 1;
    };
    const startTag = (at) => {
      if (!html.slice(at, at + 7).toLowerCase().startsWith('<script')) return -1;
      const boundary = html[at + 7] ?? '';
      if (boundary && !/[\t\n\f\r />]/u.test(boundary)) return -1;
      const end = html.indexOf('>', at + 7);
      return end < 0 ? -2 : end + 1;
    };
    while (cursor < html.length) {
      if (state === 'data') {
        if (html.startsWith('<!--', cursor)) { state = 'escaped'; cursor += 4; continue; }
        const end = endTag(cursor); if (end > 0) return end; if (end === -2) return -1;
      } else if (state === 'escaped') {
        if (html.startsWith('-->', cursor)) { state = 'data'; cursor += 3; continue; }
        const end = endTag(cursor); if (end > 0) return end; if (end === -2) return -1;
        const start = startTag(cursor); if (start > 0) { state = 'double-escaped'; cursor = start; continue; } if (start === -2) return -1;
      } else {
        const end = endTag(cursor);
        if (end > 0) { state = 'escaped'; cursor = end; continue; }
        if (end === -2) return -1;
      }
      cursor += 1;
    }
    return -1;
  };
  const rawTextEnd = (tagName, from) => {
    if (tagName === 'script') return scriptEnd(from);
    let cursor = from;
    while (cursor < html.length) { const next = html.indexOf('<', cursor); if (next < 0) return -1; const tag = readTag(next); if (tag?.name === tagName && tag.closing) return tag.end + 1; cursor = next + 1; }
    return -1;
  };
  const inertEnd = (tagName, from) => {
    if (tagName === 'script') return rawTextEnd(tagName, from);
    if (rawTextTags.has(tagName)) return rawTextEnd(tagName, from);
    let cursor = from, depth = 1;
    while (cursor < html.length) { const next = html.indexOf('<', cursor); if (next < 0) return -1; if (html.startsWith('<!--', next)) { const end = html.indexOf('-->', next + 4); if (end < 0) return -1; cursor = end + 3; continue; } const tag = readTag(next); if (tag === null) { cursor = next + 1; continue; } if (!tag.closing && tag.name === 'plaintext') return html.length; if (!tag.closing && rawTextTags.has(tag.name)) { const end = rawTextEnd(tag.name, tag.end + 1); if (end < 0) return -1; cursor = end; continue; } if (tag.name === tagName && tag.closing) { depth -= 1; if (depth === 0) return tag.end + 1; } if (tag.name === tagName && tagName === 'template' && !tag.closing) depth += 1; cursor = tag.end + 1; }
    return -1;
  };
  let cursor = 0, documentBase = new URL('https://hosted-artifact.invalid/index.html'), baseSet = false;
  while (cursor < html.length) {
    const next = html.indexOf('<', cursor); if (next < 0) break;
    if (html.startsWith('<!--', next)) { const end = html.indexOf('-->', next + 4); if (end < 0) return null; cursor = end + 3; continue; }
    const tag = readTag(next); if (tag === null) { cursor = next + 1; continue; } if (tag.closing) { cursor = tag.end + 1; continue; }
    if (tag.name === 'plaintext') return Object.freeze(paths);
    if (tag.name === 'template' || (rawTextTags.has(tag.name) && tag.name !== 'script')) { const end = inertEnd(tag.name, tag.end + 1); if (end < 0) return null; cursor = end; continue; }
    if (tag.name === 'base' && !baseSet && tag.attributes.has('href')) {
      try { documentBase = new URL(tag.attributes.get('href'), documentBase); } catch { return null; }
      baseSet = true; cursor = tag.end + 1; continue;
    }
    if (tag.name !== 'script') { cursor = tag.end + 1; continue; } const contentEnd = inertEnd('script', tag.end + 1); if (contentEnd < 0) return null;
    const type = tag.attributes.get('type')?.trim().toLowerCase();
    if (type === 'application/json') { cursor = contentEnd; continue; }
    if (type !== 'module') { cursor = contentEnd; continue; }
    const source = tag.attributes.get('src');
    if (!source) return null;
    let resource;
    try { resource = new URL(source, documentBase); } catch { return null; }
    if (resource.origin !== 'https://hosted-artifact.invalid' || resource.search || resource.hash || resource.username || resource.password || resource.pathname.includes('%')) return null;
    const normalized = resource.pathname.replace(/^\/+/, '');
    if (!normalized || normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
    paths.push(normalized);
    cursor = contentEnd;
  }
  return Object.freeze(paths);
}
function tokenizeEmittedJavaScript(source) {
  if (typeof source !== 'string') return null;
  const tokens = [];
  let index = 0;
  const isIdentifierStart = (value) => /[A-Za-z_$]/u.test(value);
  const isIdentifierPart = (value) => /[A-Za-z0-9_$]/u.test(value);
  const skipQuoted = (quote) => {
    const start = index++;
    let value = '';
    const hex = (text) => /^[0-9A-Fa-f]+$/u.test(text);
    while (index < source.length) {
      const character = source[index++];
      if (character === quote) return { start, value };
      if (character === '\\') {
        if (index >= source.length) return null;
        const escaped = source[index++];
        // StringLiteral escape decoding is part of the identity proof.  Keeping
        // raw escape text made `"\\x61"` and `"a"` different properties even
        // though JavaScript installs the same key.  Decode the unambiguous
        // grammar forms exactly and reject legacy/octal forms rather than
        // guessing at Annex B behaviour.
        if (escaped === '\n') continue;
        if (escaped === '\r') { if (source[index] === '\n') index += 1; continue; }
        if (escaped === 'x') {
          const digits = source.slice(index, index + 2);
          if (digits.length !== 2 || !hex(digits)) return null;
          value += String.fromCodePoint(Number.parseInt(digits, 16)); index += 2; continue;
        }
        if (escaped === 'u') {
          if (source[index] === '{') {
            const close = source.indexOf('}', index + 1);
            const digits = close < 0 ? '' : source.slice(index + 1, close);
            if (!digits || digits.length > 6 || !hex(digits)) return null;
            const codePoint = Number.parseInt(digits, 16);
            if (codePoint > 0x10ffff) return null;
            value += String.fromCodePoint(codePoint); index = close + 1; continue;
          }
          const digits = source.slice(index, index + 4);
          if (digits.length !== 4 || !hex(digits)) return null;
          value += String.fromCharCode(Number.parseInt(digits, 16)); index += 4; continue;
        }
        const escapes = Object.freeze({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '0': '\0' });
        if (Object.hasOwn(escapes, escaped)) {
          if (escaped === '0' && /[0-9]/u.test(source[index] ?? '')) return null;
          value += escapes[escaped]; continue;
        }
        if (/[1-9]/u.test(escaped)) return null;
        value += escaped;
      } else {
        if (character === '\n' || character === '\r') return null;
        value += character;
      }
    }
    return null;
  };
  const skipTemplateInterpolation = (start) => {
    let cursor = start, depth = 1;
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === "'" || character === '"') {
        const quote = character; cursor += 1;
        while (cursor < source.length) {
          if (source[cursor] === '\\') { cursor += 2; continue; }
          if (source[cursor] === quote) { cursor += 1; break; }
          if (source[cursor] === '\n' || source[cursor] === '\r') return -1;
          cursor += 1;
        }
        if (cursor > source.length) return -1; continue;
      }
      if (character === '`') {
        const nested = readTemplate(cursor); if (nested === null) return -1;
        cursor = nested.end;
        continue;
      }
      if (character === '/' && source[cursor + 1] === '/') {
        const lineEnd = source.indexOf('\n', cursor + 2);
        cursor = lineEnd < 0 ? source.length : lineEnd + 1;
        continue;
      }
      if (character === '/' && source[cursor + 1] === '*') {
        const commentEnd = source.indexOf('*/', cursor + 2);
        if (commentEnd < 0) return -1; cursor = commentEnd + 2;
        continue;
      }
      if (character === '{') depth += 1;
      if (character === '}' && --depth === 0) return cursor;
      cursor += 1;
    }
    return -1;
  };
  const readTemplate = (start) => {
    const substitutions = [], quasis = []; let cursor = start + 1, quasi = '';
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === '\\') { if (cursor + 1 >= source.length) return null; quasi += source.slice(cursor, cursor + 2); cursor += 2; continue; }
      if (character === '`') return { end: cursor + 1, quasis: [...quasis, quasi], substitutions };
      if (character === '$' && source[cursor + 1] === '{') {
        const substitutionStart = cursor + 2, substitutionEnd = skipTemplateInterpolation(substitutionStart);
        if (substitutionEnd < 0) return null;
        const substitution = tokenizeEmittedJavaScript(source.slice(substitutionStart, substitutionEnd));
        if (substitution === null || substitution.length === 0) return null;
        quasis.push(quasi); quasi = ''; substitutions.push(substitution); cursor = substitutionEnd + 1;
        continue;
      }
      quasi += character;
      cursor += 1;
    }
    return null;
  };
  const skipRegex = () => {
    index += 1;
    let inCharacterClass = false;
    while (index < source.length) {
      const character = source[index++];
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === '[') inCharacterClass = true;
      if (character === ']') inCharacterClass = false;
      if (character === '/' && !inCharacterClass) {
        while (index < source.length && /[A-Za-z]/u.test(source[index])) index += 1;
        return true;
      }
      if (character === '\n' || character === '\r') return false;
    }
    return false;
  };
  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      if (index < 0) break;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) return null;
      index = end + 2;
      continue;
    }
    if (character === '/') {
      const previous = tokens[tokens.length - 1]?.value;
      const canStartRegex = previous === undefined ||
        ['(', '[', '{', ',', ';', ':', '=', '!', '?', '&', '|', '+', '-', '*', '%', '~', '<', '>'].includes(previous) ||
        ['return', 'case', 'throw', 'else', 'do', 'typeof', 'void', 'new', 'in', 'of', 'yield', 'await'].includes(previous);
      if (canStartRegex && skipRegex()) continue;
    }
    if (character === '"' || character === "'") {
      const quoted = skipQuoted(character);
      if (quoted === null) return null;
      tokens.push({ kind: 'string', value: quoted.value });
      continue;
    }
    if (character === '`') {
      const template = readTemplate(index);
      if (template === null) return null;
      tokens.push({ kind: 'template', quasis: template.quasis, substitutions: template.substitutions });
      index = template.end;
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = index++;
      while (index < source.length && isIdentifierPart(source[index])) index += 1;
      tokens.push({ kind: 'word', value: source.slice(start, index) });
      continue;
    }
    if (/[0-9]/u.test(character)) {
      const start = index++;
      while (index < source.length && /[0-9A-Za-z_.]/u.test(source[index])) index += 1;
      tokens.push({ kind: 'number', value: source.slice(start, index) });
      continue;
    }
    tokens.push({ kind: 'punctuation', value: character });
    index += 1;
  }
  return tokens;
}
function tokenIs(tokens, index, value) {
  return tokens[index]?.value === value;
}
function matchingToken(tokens, start, open, close) {
  if (!tokenIs(tokens, start, open)) return -1;
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokenIs(tokens, index, open)) depth += 1;
    if (tokenIs(tokens, index, close)) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
function tokenDepths(tokens) {
  const depths = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    depths.push(depth);
    if (tokenIs(tokens, index, '{')) depth += 1;
    if (tokenIs(tokens, index, '}')) depth -= 1;
  }
  return depths;
}
export function extractHostedJavaScriptStaticModuleSpecifiers(source) {
  const tokens = tokenizeEmittedJavaScript(source);
  if (tokens === null) return null;
  const edges = [];
  const depths = tokenDepths(tokens);
  for (let index = 0; index < tokens.length; index += 1) {
    if (depths[index] !== 0 || !['import', 'export'].includes(tokens[index].value)) continue;
    if (tokenIs(tokens, index, 'import') && tokens[index + 1]?.kind === 'string') {
      edges.push(tokens[index + 1].value);
      continue;
    }
    if (tokenIs(tokens, index, 'import') && tokenIs(tokens, index + 1, '(')) continue;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      if (depths[cursor] < depths[index] || (depths[cursor] === depths[index] && tokenIs(tokens, cursor, ';'))) break;
      if (depths[cursor] === depths[index] && tokenIs(tokens, cursor, 'from') && tokens[cursor + 1]?.kind === 'string') {
        edges.push(tokens[cursor + 1].value);
        break;
      }
    }
  }
  return Object.freeze([...new Set(edges)]);
}
function resolveStaticSpecifier(importerPath, specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('./')) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(importerPath), specifier));
  return resolved.startsWith('../') || resolved === '..' || !resolved.endsWith('.js') ? null : resolved;
}
function staticImportPaths(chunkPath, source) {
  const specifiers = extractHostedJavaScriptStaticModuleSpecifiers(source);
  if (specifiers === null) return null;
  const paths = [];
  for (const specifier of specifiers) {
    const resolved = resolveStaticSpecifier(chunkPath, specifier);
    if (resolved === null) return null;
    paths.push(resolved);
  }
  return Object.freeze([...new Set(paths)].sort((left, right) => left.localeCompare(right)));
}
function staticReachability(entryPaths, chunkSources) {
  const reachable = new Set();
  const invalidPaths = new Set();
  const pending = [...entryPaths];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || reachable.has(path)) continue;
    reachable.add(path);
    const imports = staticImportPaths(path, chunkSources.get(path));
    if (imports === null) {
      invalidPaths.add(path);
      continue;
    }
    for (const importedPath of imports) {
      if (!chunkSources.has(importedPath)) invalidPaths.add(`${path}:${importedPath}`);
      else pending.push(importedPath);
    }
  }
  return { invalidPaths, reachable };
}
function importedBindings(tokens) {
  const bindings = new Map();
  const depths = tokenDepths(tokens);
  for (let index = 0; index < tokens.length; index += 1) {
    if (depths[index] !== 0 || !tokenIs(tokens, index, 'import') || tokens[index + 1]?.kind === 'string') continue;
    let from = -1;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      if (depths[cursor] < depths[index] || (depths[cursor] === depths[index] && tokenIs(tokens, cursor, ';'))) break;
      if (depths[cursor] === depths[index] && tokenIs(tokens, cursor, 'from') && tokens[cursor + 1]?.kind === 'string') {
        from = cursor;
        break;
      }
    }
    if (from < 0) continue;
    const open = tokens.findIndex((token, cursor) => cursor > index && cursor < from && token.value === '{');
    const close = matchingToken(tokens, open, '{', '}');
    if (open < 0 || close < 0 || close > from) continue;
    for (let cursor = open + 1; cursor < close; ) {
      const exported = tokens[cursor];
      if (exported?.kind !== 'word') {
        cursor += 1;
        continue;
      }
      let local = exported.value;
      cursor += 1;
      if (tokenIs(tokens, cursor, 'as') && tokens[cursor + 1]?.kind === 'word') {
        local = tokens[cursor + 1].value;
        cursor += 2;
      }
      bindings.set(local, Object.freeze({ exported: exported.value, specifier: tokens[from + 1].value }));
      while (cursor < close && !tokenIs(tokens, cursor, ',')) cursor += 1;
      if (tokenIs(tokens, cursor, ',')) cursor += 1;
    }
  }
  return bindings;
}
const intrinsicObjectProofValue = Object.freeze({ kind: 'intrinsic-object' });
const intrinsicGlobalThisProofValue = Object.freeze({ kind: 'intrinsic-global-this' });
function modeledIntrinsicBindings(tokens) {
  const bindings = new Set(), modeled = new Set(['Object', 'globalThis', 'undefined']);
  const depths = tokenDepths(tokens);
  for (let index = 0; index < tokens.length; index += 1) {
    if (depths[index] !== 0) continue;
    const next = tokens[index + 1]?.value;
    if ((['const', 'let', 'var', 'class'].includes(tokens[index].value) || tokenIs(tokens, index, 'function')) && modeled.has(next)) { bindings.add(next); continue; }
    if (!tokenIs(tokens, index, 'import')) continue;
    const end = statementEnd(tokens, index);
    if (end < 0) continue;
    for (let cursor = index + 1; cursor < end; cursor += 1) if (tokens[cursor]?.kind === 'word' && modeled.has(tokens[cursor].value)) bindings.add(tokens[cursor].value);
  }
  return bindings;
}
function safeUninvokedClass(tokens, start) {
  // A class expression/declaration evaluates its heritage, computed names,
  // field initializers, decorators, and static blocks immediately.  The proof
  // language deliberately has no evaluator for those forms.  It may only
  // retain an ordinary class whose body contains ordinary methods; every
  // potentially evaluating class feature therefore fails closed.
  let cursor = start;
  if (tokenIs(tokens, cursor, 'export')) cursor += 1;
  if (!tokenIs(tokens, cursor, 'class') || tokens[cursor + 1]?.kind !== 'word') return -1;
  const bodyStart = cursor + 2;
  if (!tokenIs(tokens, bodyStart, '{')) return -1; // Includes `extends`.
  const bodyEnd = matchingToken(tokens, bodyStart, '{', '}');
  if (bodyEnd < 0) return -1;
  let depth = 0;
  for (let index = bodyStart + 1; index < bodyEnd; index += 1) {
    const token = tokens[index]?.value;
    if (depth === 0 && ['[', '=', ';', 'static', '@', '#'].includes(token)) return -1;
    if (token === '{' || token === '(' || token === '[') depth += 1;
    if (token === '}' || token === ')' || token === ']') depth -= 1;
    // At class-element depth, `[` is a computed key, `=` starts a field
    // initializer, `;` is a field declaration, and `static`/`@` can execute
    // during definition.  Method bodies are below this depth and need not run.
  }
  return bodyEnd;
}
function callableExports(source) {
  const tokens = tokenizeEmittedJavaScript(source); if (tokens === null) return null;
  const depths = tokenDepths(tokens), values = new Map(), exported = new Map();
  const callableValue = (name, kind) => Object.freeze({ kind: 'callable', callableKind: kind, localExport: name });
  const assignedValue = (start, end) => start >= end ? null : tokens[start]?.kind === 'word' && start + 1 === end ? values.get(tokens[start].value) ?? null : tokenIs(tokens, start, 'undefined') && start + 1 === end ? undefinedProofValue : isUninvokedFunctionValue(tokens, start, end) ? callableValue(`anonymous-${start}`, 'function') : null;
  for (let index = 0; index < tokens.length; index += 1) {
    if (depths[index] !== 0) continue;
    if (tokenIs(tokens, index, ';')) continue;
    if (tokenIs(tokens, index, 'import')) {
      const end = statementEnd(tokens, index);
      if (end < 0 || tokenIs(tokens, index + 1, '(')) return null;
      index = end;
      continue;
    }
    if (tokens[index].value === 'function' && tokens[index + 1]?.kind === 'word') {
      const name = tokens[index + 1].value, end = uninvokedFunctionEnd(tokens, index);
      if (end < 0) return null;
      values.set(name, callableValue(name, 'function'));
      index = end;
      continue;
    }
    if (tokens[index].value === 'class' && tokens[index + 1]?.kind === 'word') {
      const name = tokens[index + 1].value, bodyEnd = safeUninvokedClass(tokens, index);
      if (bodyEnd < 0) return null;
      values.set(name, callableValue(name, 'class'));
      index = bodyEnd;
      continue;
    }
    if (['throw', 'if', 'for', 'while', 'do', 'switch', 'try', 'with'].includes(tokens[index].value) || tokenIs(tokens, index, '{')) return null;
    if (['const', 'let', 'var'].includes(tokens[index].value)) {
      const end = statementEnd(tokens, index); if (end < 0) return null;
      for (const declaration of declarationParts(tokens, index + 1, end)) { if (declaration.name === null) return null; const value = assignedValue(declaration.valueStart, declaration.end); if (value === null) return null; values.set(declaration.name, value); }
      index = end;
      continue;
    }
    if (tokens[index]?.kind === 'word' && tokenIs(tokens, index + 1, '=')) return null;
    const compoundEnd = tokens[index]?.kind === 'word' && tokenIs(tokens, index + 2, '=') && ['+', '-', '*', '/', '%', '&', '|', '^', '<', '>', '?'].includes(tokens[index + 1]?.value) ? index + 3 :
      tokens[index]?.kind === 'word' && tokenIs(tokens, index + 3, '=') && [['*', '*'], ['<', '<'], ['>', '>'], ['&', '&'], ['|', '|'], ['?', '?']].some(([left, right]) => tokenIs(tokens, index + 1, left) && tokenIs(tokens, index + 2, right)) ? index + 4 : tokens[index]?.kind === 'word' && tokenIs(tokens, index + 4, '=') && tokenIs(tokens, index + 1, '>') && tokenIs(tokens, index + 2, '>') && tokenIs(tokens, index + 3, '>') ? index + 5 : -1;
    if ((tokens[index]?.kind === 'word' && ['+', '-'].includes(tokens[index + 1]?.value) && tokenIs(tokens, index + 1, tokens[index + 2]?.value)) || (['+', '-'].includes(tokens[index]?.value) && tokens[index + 1]?.kind === 'word')) { values.delete(tokens[index]?.kind === 'word' ? tokens[index].value : tokens[index + 1].value); continue; }
    if (compoundEnd >= 0) { const end = statementEnd(tokens, index); if (end < 0) return null; values.delete(tokens[index].value); index = end; continue; }
    if (tokenIs(tokens, index, 'for') && tokenIs(tokens, index + 1, '(') && tokens[index + 2]?.kind === 'word' && ['in', 'of'].includes(tokens[index + 3]?.value)) { values.delete(tokens[index + 2].value); continue; }
    if (['(', '[', '{'].includes(tokens[index]?.value)) { const close = matchingToken(tokens, index, tokens[index].value, ({ '(': ')', '[': ']', '{': '}' })[tokens[index].value]); if (close >= 0 && tokenIs(tokens, close + 1, '=')) { for (let cursor = index + 1; cursor < close; cursor += 1) if (tokens[cursor]?.kind === 'word') values.delete(tokens[cursor].value); const end = statementEnd(tokens, index); if (end < 0) return null; index = end; continue; } }
    if (tokenIs(tokens, index, 'export') && ['function', 'class'].includes(tokens[index + 1]?.value) && tokens[index + 2]?.kind === 'word') exported.set(tokens[index + 2].value, tokens[index + 2].value);
    if (tokenIs(tokens, index, 'export') && ['function', 'class'].includes(tokens[index + 1]?.value)) {
      if (tokens[index + 2]?.kind !== 'word') return null;
      if (tokenIs(tokens, index + 1, 'class') && safeUninvokedClass(tokens, index) < 0) return null;
      exported.set(tokens[index + 2].value, tokens[index + 2].value);
      continue;
    }
    if (!tokenIs(tokens, index, 'export') || !tokenIs(tokens, index + 1, '{')) return null;
    const close = matchingToken(tokens, index + 1, '{', '}');
    if (close < 0) continue;
    for (let cursor = index + 2; cursor < close; ) {
      const local = tokens[cursor];
      if (local?.kind !== 'word') {
        cursor += 1;
        continue;
      }
      let exportedName = local.value;
      cursor += 1;
      if (tokenIs(tokens, cursor, 'as') && tokens[cursor + 1]?.kind === 'word') {
        exportedName = tokens[cursor + 1].value;
        cursor += 2;
      }
      exported.set(exportedName, local.value);
      while (cursor < close && !tokenIs(tokens, cursor, ',')) cursor += 1;
      if (tokenIs(tokens, cursor, ',')) cursor += 1;
    }
    index = close;
  }
  return Object.freeze({ callable: new Map([...values].filter(([, value]) => value?.kind === 'callable')), exported });
}
function statementEnd(tokens, start) {
  const startDepth = tokenDepths(tokens)[start];
  for (let index = start; index < tokens.length; index += 1) if (tokenDepths(tokens)[index] === startDepth && tokenIs(tokens, index, ';')) return index;
  return -1;
}
function declarationParts(tokens, start, end) {
  const declarations = [], separators = []; let depth = 0, partStart = start;
  for (let index = start; index < end; index += 1) { if (['(', '[', '{'].includes(tokens[index]?.value)) depth += 1; if ([')', ']', '}'].includes(tokens[index]?.value)) depth -= 1; if (depth === 0 && tokenIs(tokens, index, ',')) { separators.push([partStart, index]); partStart = index + 1; } }
  separators.push([partStart, end]);
  for (const [from, to] of separators) {
    const name = tokens[from]?.kind === 'word' ? tokens[from].value : null;
    declarations.push({ end: to, name, valueStart: tokenIs(tokens, from + 1, '=') ? from + 2 : to });
  }
  return declarations;
}
function isUninvokedFunctionValue(tokens, start, end) {
  let cursor = start;
  if (tokenIs(tokens, cursor, 'async')) cursor += 1;
  if (tokenIs(tokens, cursor, 'function')) {
    cursor += 1;
    if (tokenIs(tokens, cursor, '*')) cursor += 1;
    if (tokens[cursor]?.kind === 'word') cursor += 1;
    const parametersEnd = matchingToken(tokens, cursor, '(', ')');
    if (parametersEnd < 0 || !tokenIs(tokens, parametersEnd + 1, '{')) return false;
    return matchingToken(tokens, parametersEnd + 1, '{', '}') === end - 1;
  }
  let parametersEnd = -1;
  if (tokens[cursor]?.kind === 'word') parametersEnd = cursor;
  if (tokenIs(tokens, cursor, '(')) parametersEnd = matchingToken(tokens, cursor, '(', ')');
  if (parametersEnd < 0 || !tokenIs(tokens, parametersEnd + 1, '=') || !tokenIs(tokens, parametersEnd + 2, '>')) {
    return false;
  }
  const bodyStart = parametersEnd + 3;
  if (bodyStart >= end) return false;
  if (tokenIs(tokens, bodyStart, '{')) return matchingToken(tokens, bodyStart, '{', '}') === end - 1;
  return true;
}
function safeTemplateValue(template, values) {
  const substitutions = template.substitutions.map((substitution) => safeObjectValue(substitution, 0, substitution.length, values));
  if (substitutions.some((value) => value === null || !['boolean', 'string', 'template', 'undefined'].includes(value.kind))) return null;
  return Object.freeze({ kind: 'template', quasis: Object.freeze(template.quasis), substitutions: Object.freeze(substitutions) });
}
function safeObjectValue(tokens, start, end, values) {
  if (start >= end) return null;
  if (tokenIs(tokens, start, 'true') && start + 1 === end) {
    return Object.freeze({ kind: 'boolean', value: true });
  }
  if (tokenIs(tokens, start, 'false') && start + 1 === end) {
    return Object.freeze({ kind: 'boolean', value: false });
  }
  if (tokens[start]?.kind === 'template' && start + 1 === end) {
    return safeTemplateValue(tokens[start], values);
  }
  if (tokens[start]?.kind === 'string' && start + 1 === end) {
    return Object.freeze({ kind: 'string', value: tokens[start].value });
  }
  if (tokenIs(tokens, start, 'undefined') && start + 1 === end) {
    return values.get('undefined') ?? null;
  }
  if (
    tokenIs(tokens, start, '!') &&
    tokens[start + 1]?.kind === 'number' &&
    start + 2 === end &&
    ['0', '1'].includes(tokens[start + 1].value)
  ) {
    return Object.freeze({ kind: 'boolean', value: tokens[start + 1].value === '0' });
  }
  if (tokens[start]?.kind === 'word' && start + 1 === end) return values.get(tokens[start].value) ?? null;
  if (tokenIs(tokens, start, '(') && matchingToken(tokens, start, '(', ')') === end - 1) {
    return safeObjectValue(tokens, start + 1, end - 1, values);
  }
  if (isUninvokedFunctionValue(tokens, start, end)) {
    return Object.freeze({ kind: 'uninvoked-function' });
  }
  if (
    tokenIs(tokens, start, 'Object') &&
    tokenIs(tokens, start + 1, '.') &&
    tokenIs(tokens, start + 2, 'freeze') &&
    tokenIs(tokens, start + 3, '(') &&
    tokenIs(tokens, end - 1, ')') &&
    values.get('Object') === intrinsicObjectProofValue
  ) {
    return safeObjectValue(tokens, start + 4, end - 1, values);
  }
  if (!tokenIs(tokens, start, '{') || matchingToken(tokens, start, '{', '}') !== end - 1) return null;
  const object = new Map();
  let cursor = start + 1;
  while (cursor < end - 1) {
    const key = tokens[cursor];
    if (key?.kind !== 'word' && key?.kind !== 'string') return null;
    cursor += 1;
    let valueEnd = cursor;
    if (tokenIs(tokens, cursor, ':')) {
      const valueStart = cursor + 1;
      cursor = valueStart;
      let nesting = 0;
      while (cursor < end - 1) {
        if (['(', '[', '{'].includes(tokens[cursor].value)) nesting += 1;
        if ([')', ']', '}'].includes(tokens[cursor].value)) nesting -= 1;
        if (nesting === 0 && tokenIs(tokens, cursor, ',')) break;
        cursor += 1;
      }
      valueEnd = cursor;
      const value = safeObjectValue(tokens, valueStart, valueEnd, values) ??
        Object.freeze({ kind: 'opaque' });
      if (object.has(key.value)) return null;
      object.set(key.value, value);
    } else {
      const value = values.get(key.value);
      if (value === undefined) return null;
      if (object.has(key.value)) return null;
      object.set(key.value, value);
    }
    if (cursor === end - 1) break;
    if (!tokenIs(tokens, cursor, ',')) return null;
    cursor += 1;
  }
  return Object.freeze({ kind: 'object', properties: object });
}
function isProofSafeValue(value) {
  if (
    value === undefined ||
    ['opaque', 'intrinsic-object', 'intrinsic-global-this'].includes(value.kind)
  ) return false;
  if (value.kind !== 'object') return true;
  for (const nestedValue of value.properties.values()) {
    if (!isProofSafeValue(nestedValue)) return false;
  }
  return true;
}
function propertyDescriptor(descriptor) {
  if (descriptor?.kind !== 'object') return null;
  const allowed = new Set(['configurable', 'enumerable', 'value', 'writable', 'get', 'set']);
  for (const [name, value] of descriptor.properties) {
    if (!allowed.has(name) || !isProofSafeValue(value)) return null;
    if (['configurable', 'enumerable', 'writable'].includes(name) && value?.kind !== 'boolean') {
      return null;
    }
    if (!['get', 'set'].includes(name)) continue;
    if (!['callable', 'uninvoked-function', 'undefined'].includes(value?.kind)) {
      return null;
    }
  }
  const hasData = descriptor.properties.has('value') || descriptor.properties.has('writable');
  const hasAccessor = descriptor.properties.has('get') || descriptor.properties.has('set');
  if (hasData && hasAccessor) return null;
  return Object.freeze({
    kind: hasData ? 'data' : hasAccessor ? 'accessor' : 'generic',
    configurable: descriptor.properties.get('configurable'),
    enumerable: descriptor.properties.get('enumerable'),
    writable: descriptor.properties.get('writable'),
    value: descriptor.properties.get('value'),
    get: descriptor.properties.get('get'),
    set: descriptor.properties.get('set'),
    hasConfigurable: descriptor.properties.has('configurable'),
    hasEnumerable: descriptor.properties.has('enumerable'),
    hasWritable: descriptor.properties.has('writable'),
    hasValue: descriptor.properties.has('value'),
    hasGet: descriptor.properties.has('get'),
    hasSet: descriptor.properties.has('set'),
  });
}
const undefinedProofValue = Object.freeze({ kind: 'undefined' });
function sameProofValue(left, right) {
  if (left?.kind !== right?.kind) return false;
  if (left?.kind === 'boolean') return left.value === right.value;
  if (left?.kind === 'string') return left.value === right.value;
  if (left?.kind === 'template') return left.quasis.length === right.quasis.length && left.quasis.every((quasi, index) => quasi === right.quasis[index] && sameProofValue(left.substitutions[index], right.substitutions[index]));
  if (left?.kind === 'undefined') return true;
  return left === right;
}
function completePropertyDescriptor(descriptor, kind) {
  if (kind === 'accessor') {
    return Object.freeze({
      kind,
      configurable: descriptor.hasConfigurable ? descriptor.configurable.value : false,
      enumerable: descriptor.hasEnumerable ? descriptor.enumerable.value : false,
      get: descriptor.hasGet ? descriptor.get : undefinedProofValue,
      set: descriptor.hasSet ? descriptor.set : undefinedProofValue,
    });
  }
  return Object.freeze({
    kind: 'data',
    configurable: descriptor.hasConfigurable ? descriptor.configurable.value : false,
    enumerable: descriptor.hasEnumerable ? descriptor.enumerable.value : false,
    writable: descriptor.hasWritable ? descriptor.writable.value : false,
    value: descriptor.hasValue ? descriptor.value : undefinedProofValue,
  });
}
function convertPropertyDescriptor(current, descriptor, kind) {
  const flags = {
    configurable: descriptor.hasConfigurable ? descriptor.configurable.value : current.configurable,
    enumerable: descriptor.hasEnumerable ? descriptor.enumerable.value : current.enumerable,
  };
  if (kind === 'accessor') {
    return Object.freeze({
      kind,
      ...flags,
      get: descriptor.hasGet ? descriptor.get : undefinedProofValue,
      set: descriptor.hasSet ? descriptor.set : undefinedProofValue,
    });
  }
  return Object.freeze({
    kind: 'data',
    ...flags,
    writable: descriptor.hasWritable ? descriptor.writable.value : false,
    value: descriptor.hasValue ? descriptor.value : undefinedProofValue,
  });
}
function applyPropertyDescriptor(current, descriptor) {
  const targetKind = descriptor.kind === 'generic' ? current?.kind ?? 'data' : descriptor.kind;
  if (current === undefined) return completePropertyDescriptor(descriptor, targetKind);
  if (!current.configurable) {
    if (descriptor.hasConfigurable && descriptor.configurable.value) return null;
    if (descriptor.hasEnumerable && descriptor.enumerable.value !== current.enumerable) return null;
    if (targetKind !== current.kind) return null;
    if (current.kind === 'data') {
      if (!current.writable) {
        if (descriptor.hasWritable && descriptor.writable.value) return null;
        if (descriptor.hasValue && !sameProofValue(descriptor.value, current.value)) return null;
      }
    } else {
      if (descriptor.hasGet && !sameProofValue(descriptor.get, current.get)) return null;
      if (descriptor.hasSet && !sameProofValue(descriptor.set, current.set)) return null;
    }
  }
  if (targetKind !== current.kind) return convertPropertyDescriptor(current, descriptor, targetKind);
  if (targetKind === 'accessor') {
    return Object.freeze({
      kind: targetKind,
      configurable: descriptor.hasConfigurable ? descriptor.configurable.value : current.configurable,
      enumerable: descriptor.hasEnumerable ? descriptor.enumerable.value : current.enumerable,
      get: descriptor.hasGet ? descriptor.get : current.get,
      set: descriptor.hasSet ? descriptor.set : current.set,
    });
  }
  return Object.freeze({
    kind: 'data',
    configurable: descriptor.hasConfigurable ? descriptor.configurable.value : current.configurable,
    enumerable: descriptor.hasEnumerable ? descriptor.enumerable.value : current.enumerable,
    writable: descriptor.hasWritable ? descriptor.writable.value : current.writable,
    value: descriptor.hasValue ? descriptor.value : current.value,
  });
}
function importedCallableValues(entryPath, tokens, chunkSources) {
  const values = new Map();
  const identities = new Map();
  for (const [local, binding] of importedBindings(tokens)) {
    const importedPath = resolveStaticSpecifier(entryPath, binding.specifier);
    const exports = importedPath === null ? null : callableExports(chunkSources.get(importedPath));
    const localExport = exports?.exported.get(binding.exported);
    const callable = localExport === undefined ? undefined : exports?.callable.get(localExport);
    if (callable === undefined) continue;
    const identity = `${importedPath}\u0000${callable.localExport}`;
    let value = identities.get(identity);
    if (value === undefined) {
      value = Object.freeze({
        kind: 'callable',
        callableKind: callable.callableKind,
        importedPath,
        localExport,
      });
      identities.set(identity, value);
    }
    values.set(local, value);
  }
  return values;
}
function uninvokedFunctionEnd(tokens, start) {
  let cursor = start;
  if (tokenIs(tokens, cursor, 'async')) cursor += 1;
  if (!tokenIs(tokens, cursor, 'function')) return -1;
  cursor += 1;
  if (tokenIs(tokens, cursor, '*')) cursor += 1;
  if (tokens[cursor]?.kind !== 'word') return -1;
  const parametersEnd = matchingToken(tokens, cursor + 1, '(', ')');
  if (parametersEnd < 0 || !tokenIs(tokens, parametersEnd + 1, '{')) return -1;
  return matchingToken(tokens, parametersEnd + 1, '{', '}');
}
function argumentRanges(tokens, start, end) {
  const ranges = [], separators = []; let depth = 0, from = start;
  for (let index = start; index < end; index += 1) { if (['(', '[', '{'].includes(tokens[index]?.value)) depth += 1; if ([')', ']', '}'].includes(tokens[index]?.value)) depth -= 1; if (depth === 0 && tokenIs(tokens, index, ',')) { separators.push([from, index]); from = index + 1; } }
  separators.push([from, end]); return separators;
}
function memberAt(tokens, index, values) { const value = tokens[index]?.kind === 'word' ? values.get(tokens[index].value) : undefined; return tokenIs(tokens, index + 1, '.') && tokens[index + 2]?.kind === 'word' ? { end: index + 3, property: tokens[index + 2].value, value } : { end: index + 1, property: null, value }; }
function intrinsicGlobalAt(tokens, start, end, values) { return end === start + 1 && tokens[start]?.kind === 'word' && values.get(tokens[start].value) === intrinsicGlobalThisProofValue; }
function intrinsicObjectAt(tokens, index, values) { if (tokens[index]?.kind === 'word' && values.get(tokens[index].value) === intrinsicObjectProofValue) return { end: index + 1 }; const member = memberAt(tokens, index, values); return member.value === intrinsicGlobalThisProofValue && member.property === 'Object' && values.get('Object') === intrinsicObjectProofValue ? member : null; }
function assignedProofValue(tokens, start, end, values = new Map()) { const value = safeObjectValue(tokens, start, end, values); return value !== null && (isProofSafeValue(value) || value === intrinsicObjectProofValue || value === intrinsicGlobalThisProofValue) ? value : null; }
function ordinaryAssignment(value) { return Object.freeze({ kind: 'data', configurable: true, enumerable: true, value, writable: true }); }
function assignedProperty(current, value) { if (current === undefined) return ordinaryAssignment(value); if (current.kind !== 'data' || !current.writable) return null; return Object.freeze({ ...current, value }); }
function syncModeledGlobal(values, name, property) { if (!['Object', 'globalThis'].includes(name)) return; if (property?.kind === 'data') values.set(name, property.value); else values.delete(name); }
function invalidateIntrinsicIdentity(values, identity) {
  for (const [name, value] of values) if (value === identity) values.delete(name);
}
function seededGlobalProperties() {
  const frozenOpaque = Object.freeze({ kind: 'opaque' });
  return new Map([
    ['Object', ordinaryAssignment(intrinsicObjectProofValue)],
    ['globalThis', ordinaryAssignment(intrinsicGlobalThisProofValue)],
    // ESM evaluation is strict.  These own global properties are authoritative
    // non-writable/non-configurable data descriptors, not unknown user fields.
    ['undefined', Object.freeze({ kind: 'data', configurable: false, enumerable: false, value: undefinedProofValue, writable: false })],
    ['NaN', Object.freeze({ kind: 'data', configurable: false, enumerable: false, value: frozenOpaque, writable: false })],
    ['Infinity', Object.freeze({ kind: 'data', configurable: false, enumerable: false, value: frozenOpaque, writable: false })],
  ]);
}
function evaluateBrowserEntryInstallation(entryPath, source, globalName, chunkSources) {
  const tokens = tokenizeEmittedJavaScript(source); if (tokens === null) return null;
  const values = importedCallableValues(entryPath, tokens, chunkSources), shadows = modeledIntrinsicBindings(tokens), installed = seededGlobalProperties();
  if (!shadows.has('Object')) values.set('Object', intrinsicObjectProofValue); if (!shadows.has('globalThis')) values.set('globalThis', intrinsicGlobalThisProofValue); if (!shadows.has('undefined')) values.set('undefined', undefinedProofValue);
  for (let cursor = 0; cursor < tokens.length;) {
    if (tokenIs(tokens, cursor, ';')) { cursor += 1; continue; }
    if (tokenIs(tokens, cursor, 'import')) { const end = statementEnd(tokens, cursor); if (tokenIs(tokens, cursor + 1, '(') || end < 0) return null; cursor = end + 1; continue; }
    if (tokenIs(tokens, cursor, 'export')) { const close = tokenIs(tokens, cursor + 1, '{') ? matchingToken(tokens, cursor + 1, '{', '}') : -1; if (close < 0 || (close + 1 < tokens.length && !tokenIs(tokens, close + 1, ';'))) return null; cursor = close + (tokenIs(tokens, close + 1, ';') ? 2 : 1); continue; }
    const functionEnd = uninvokedFunctionEnd(tokens, cursor); if (functionEnd >= 0) { cursor = functionEnd + 1; continue; }
    if (['const', 'let', 'var'].includes(tokens[cursor]?.value)) {
      const end = statementEnd(tokens, cursor); if (end < 0) return null;
      for (const declaration of declarationParts(tokens, cursor + 1, end)) { const value = declaration.name === null ? null : assignedProofValue(tokens, declaration.valueStart, declaration.end, values); if (value === null) return null; values.set(declaration.name, value); }
      cursor = end + 1; continue;
    }
    const receiver = intrinsicObjectAt(tokens, cursor, values), method = receiver !== null && tokenIs(tokens, receiver.end, '.') ? tokens[receiver.end + 1]?.value : null;
    if (receiver !== null && ['defineProperty', 'defineProperties'].includes(method) && tokenIs(tokens, receiver.end + 2, '(')) {
      const close = matchingToken(tokens, receiver.end + 2, '(', ')'); if (close < 0 || !tokenIs(tokens, close + 1, ';')) return null;
      const args = argumentRanges(tokens, receiver.end + 3, close); if (args.some(([start, end]) => assignedProofValue(tokens, start, end, values) === null)) return null;
      const [target, name, description] = args;
      // Descriptor conversion happens before DefineProperty selects or mutates
      // its target.  Check it for every target (including unknown objects), so
      // malformed data/accessor mixtures cannot hide behind an unmodeled one.
      if (method === 'defineProperty') {
        if (!description || propertyDescriptor(assignedProofValue(tokens, description[0], description[1], values)) === null) return null;
      } else {
        const descriptions = name && assignedProofValue(tokens, name[0], name[1], values);
        if (args.length !== 2 || descriptions?.kind !== 'object' || ![...descriptions.properties.values()].every((value) => propertyDescriptor(value) !== null)) return null;
      }
      const targetGlobal = target && intrinsicGlobalAt(tokens, target[0], target[1], values); const targetObject = target && tokens[target[0]]?.kind === 'word' && target[1] === target[0] + 1 && values.get(tokens[target[0]].value) === intrinsicObjectProofValue;
      if (!targetGlobal && !targetObject) return null;
      // This call changes the intrinsic object itself.  Every capability alias
      // has the same identity, so retaining O after O.defineProperty(Object,
      // "defineProperty", ...) would model a method that no longer exists.
      if (targetObject) { invalidateIntrinsicIdentity(values, intrinsicObjectProofValue); cursor = close + 2; continue; }
      const install = (key, value) => { const descriptor = propertyDescriptor(value); const next = descriptor === null ? null : applyPropertyDescriptor(installed.get(key), descriptor); if (next === null) return false; installed.set(key, next); syncModeledGlobal(values, key, next); return true; };
      if (method === 'defineProperty') { if (!name || !description || name[1] !== name[0] + 1 || tokens[name[0]]?.kind !== 'string' || !install(tokens[name[0]].value, assignedProofValue(tokens, description[0], description[1], values))) return null; }
      else { const descriptions = name && assignedProofValue(tokens, name[0], name[1], values); if (descriptions?.kind !== 'object' || ![...descriptions.properties].every(([key, value]) => install(key, value))) return null; }
      cursor = close + 2; continue;
    }
    const member = memberAt(tokens, cursor, values), end = statementEnd(tokens, cursor);
    if (end >= 0 && tokenIs(tokens, member.end, '=') && member.property !== null) {
      const value = assignedProofValue(tokens, member.end + 1, end, values); if (value === null || member.value !== intrinsicGlobalThisProofValue) return null;
      const next = assignedProperty(installed.get(member.property), value); if (next === null) return null; installed.set(member.property, next); syncModeledGlobal(values, member.property, next); cursor = end + 1; continue;
    }
    // A bare write in an ESM entry can target an imported or const binding, an
    // unresolvable reference, or a strict global alias.  We do not have a
    // complete lexical environment here, so accepting it would be unsound.
    // Reject rather than letting a later installer appear reachable.
    if (end >= 0 && tokens[cursor]?.kind === 'word' && tokenIs(tokens, cursor + 1, '=')) return null;
    return null;
  }
  const property = installed.get(globalName); return property?.kind === 'data' && isProofSafeValue(property.value) ? property.value : null;
}
function hasCallableSharedApis(entryPath, source, globalName, chunkSources, chunksByPath) {
  const installed = evaluateBrowserEntryInstallation(entryPath, source, globalName, chunkSources);
  if (installed?.kind !== 'object') return false;
  for (const [apiName, callableKind] of [
    ['createHostedCoordinationEventStreamObserver', 'function'],
    ['HostedCoordinationEventStreamParser', 'class'],
  ]) {
    const api = installed.properties.get(apiName);
    const importedChunk = api?.kind === 'callable' ? chunksByPath.get(api.importedPath) : undefined;
    if (
      importedChunk === undefined ||
      api.callableKind !== callableKind ||
      !importedChunk.moduleIds.includes('src/features/coordination-events/renderer/transport/HostedCoordinationEventStreamObserver.ts') ||
      !importedChunk.moduleIds.includes('src/features/coordination-events/renderer/transport/HostedCoordinationEventStreamParser.ts')
    ) {
      return false;
    }
  }
  return true;
}
export function inspectHostedBrowserEventStreamProof({
  entryPaths,
  chunks,
  globalName,
  entryModuleId,
  requiredModuleIds,
}) {
  const chunkSources = new Map();
  const chunksByPath = new Map();
  for (const chunk of chunks) {
    if (!isRecord(chunk) || typeof chunk.fileName !== 'string' || typeof chunk.source !== 'string' || !Array.isArray(chunk.moduleIds)) {
      return Object.freeze({ reachableChunkPaths: Object.freeze([]), violations: Object.freeze(['hosted_renderer_graph_emitted_chunk_invalid']) });
    }
    chunkSources.set(chunk.fileName, chunk.source);
    chunksByPath.set(chunk.fileName, chunk);
  }
  if (!Array.isArray(entryPaths) || !entryPaths.every((path) => typeof path === 'string')) {
    return Object.freeze({
      reachableChunkPaths: Object.freeze([]),
      violations: Object.freeze(['hosted_renderer_graph_proof_entry_invalid']),
    });
  }
  const proofEntries = entryPaths.filter((path) =>
    chunksByPath.get(path)?.moduleIds.includes(entryModuleId)
  );
  if (proofEntries.length !== 1) {
    const violations = [
      proofEntries.length === 0
        ? `hosted_renderer_graph_proof_entry_html_unreachable:${entryModuleId}`
        : `hosted_renderer_graph_proof_entry_html_ambiguous:${entryModuleId}`,
    ];
    for (const moduleId of requiredModuleIds) {
      violations.push(`hosted_renderer_graph_required_module_unreachable:${moduleId}`);
    }
    violations.push(`hosted_renderer_graph_browser_callable_api_installation_missing:${globalName}`);
    return Object.freeze({
      reachableChunkPaths: Object.freeze([]),
      violations: Object.freeze(violations),
    });
  }
  const graph = staticReachability(proofEntries, chunkSources);
  const violations = [...graph.invalidPaths]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => `hosted_renderer_graph_emitted_static_edge_invalid:${path}`);
  for (const moduleId of requiredModuleIds) {
    if (![...graph.reachable].some((chunkPath) => chunksByPath.get(chunkPath)?.moduleIds.includes(moduleId))) {
      violations.push(`hosted_renderer_graph_required_module_unreachable:${moduleId}`);
    }
  }
  const proofEntry = proofEntries[0];
  // Imports are evaluated before the importing module, including bare
  // side-effect imports and transitive dependencies.  A callable export is
  // therefore not enough evidence on its own: every dependency initializer in
  // the entry's static closure must be accepted by the restricted evaluator.
  const reachableDependenciesEvaluate = [...graph.reachable]
    .filter((chunkPath) => chunkPath !== proofEntry)
    .every((chunkPath) => callableExports(chunkSources.get(chunkPath) ?? '') !== null);
  if (!hasCallableSharedApis(
    proofEntry,
    chunkSources.get(proofEntry) ?? '',
    globalName,
    chunkSources,
    chunksByPath
  ) || !reachableDependenciesEvaluate) {
    violations.push(`hosted_renderer_graph_browser_callable_api_installation_missing:${globalName}`);
  }
  return Object.freeze({
    reachableChunkPaths: Object.freeze([...graph.reachable].sort((left, right) => left.localeCompare(right))),
    violations: Object.freeze(violations),
  });
}
