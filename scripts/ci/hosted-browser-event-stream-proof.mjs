import { parse } from 'acorn';

import {
  collectRendererJavaScript,
  hasExactKeys,
  HOSTED_BROWSER_EVENT_STREAM_API,
  HOSTED_BROWSER_EVENT_STREAM_ENTRY,
  HOSTED_BROWSER_EVENT_STREAM_GLOBAL,
  HOSTED_RENDERER_GRAPH_MANIFEST,
  hostedBrowserChunkIsolationViolations,
  isCanonicalGraphModuleId,
  isRecord,
  isSortedUniqueStrings,
  resolveJavaScriptSpecifier,
  sha256,
} from './hosted-browser-event-stream-proof-graph.mjs';
import {
  consumeBalanced,
  findHostedStatementEnd,
  tokenizeHostedJavaScript,
  tokenValue,
} from './hosted-browser-event-stream-proof-syntax.mjs';

export { extractHostedHtmlModuleScriptPaths } from './hosted-browser-event-stream-proof-html.mjs';
export {
  collectRendererJavaScript,
  hasExactKeys,
  HOSTED_BROWSER_EVENT_STREAM_API,
  HOSTED_BROWSER_EVENT_STREAM_ENTRY,
  HOSTED_BROWSER_EVENT_STREAM_GLOBAL,
  HOSTED_RENDERER_GRAPH_MANIFEST,
  hostedBrowserChunkIsolationViolations,
  isCanonicalGraphModuleId,
  isRecord,
  isSortedUniqueStrings,
  sha256,
};

function parseNamedImport(tokens, start, sourcePath) {
  if (tokenValue(tokens, start) !== 'import' || tokenValue(tokens, start + 1) !== '{') return null;
  const close = consumeBalanced(tokens, start + 1, '{', '}');
  if (
    close < 0 ||
    tokenValue(tokens, close + 1) !== 'from' ||
    tokens[close + 2]?.kind !== 'string' ||
    tokenValue(tokens, close + 3) !== ';'
  ) {
    return null;
  }
  const path = resolveJavaScriptSpecifier(sourcePath, tokens[close + 2].value);
  if (path === null) return null;
  const bindings = [];
  for (let cursor = start + 2; cursor < close; ) {
    const imported = tokens[cursor];
    if (imported?.kind !== 'word') return null;
    let local = imported.value;
    cursor += 1;
    if (tokenValue(tokens, cursor) === 'as') {
      if (tokens[cursor + 1]?.kind !== 'word') return null;
      local = tokens[cursor + 1].value;
      cursor += 2;
    }
    bindings.push(Object.freeze({ imported: imported.value, local, path }));
    if (cursor < close) {
      if (tokenValue(tokens, cursor) !== ',') return null;
      cursor += 1;
    }
  }
  return Object.freeze({ bindings: Object.freeze(bindings), end: close + 4, path });
}

function parseTopLevelImports(tokens, sourcePath) {
  const bindings = new Map();
  const paths = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; ) {
    const token = tokenValue(tokens, index);
    if (depth === 0 && token === 'import') {
      const source = tokens[index + 1];
      if (source?.kind === 'string' && tokenValue(tokens, index + 2) === ';') {
        const path = resolveJavaScriptSpecifier(sourcePath, source.value);
        if (path === null) return null;
        paths.push(path);
        index += 3;
        continue;
      }
      const parsed = parseNamedImport(tokens, index, sourcePath);
      if (parsed === null) return null;
      paths.push(parsed.path);
      for (const binding of parsed.bindings) {
        if (bindings.has(binding.local)) return null;
        bindings.set(binding.local, binding);
      }
      index = parsed.end;
      continue;
    }
    if (['{', '(', '['].includes(token)) depth += 1;
    if (['}', ')', ']'].includes(token)) depth -= 1;
    if (depth < 0) return null;
    index += 1;
  }
  return depth === 0
    ? Object.freeze({ bindings, paths: Object.freeze([...new Set(paths)]) })
    : null;
}

function isCallableInitializer(tokens, start, end) {
  while (
    tokenValue(tokens, start) === '(' &&
    consumeBalanced(tokens, start, '(', ')') === end - 1
  ) {
    start += 1;
    end -= 1;
  }
  let cursor = start;
  if (tokenValue(tokens, cursor) === 'async') cursor += 1;
  if (tokenValue(tokens, cursor) === 'function') {
    cursor += 1;
    if (tokenValue(tokens, cursor) === '*') cursor += 1;
    if (tokens[cursor]?.kind === 'word') cursor += 1;
    const parametersEnd = consumeBalanced(tokens, cursor, '(', ')');
    if (parametersEnd < 0) return false;
    const bodyEnd = consumeBalanced(tokens, parametersEnd + 1, '{', '}');
    return bodyEnd === end - 1;
  }

  if (tokens[cursor]?.kind === 'word') cursor += 1;
  else {
    const parametersEnd = consumeBalanced(tokens, cursor, '(', ')');
    if (parametersEnd < 0) return false;
    cursor = parametersEnd + 1;
  }
  if (tokenValue(tokens, cursor) !== '=' || tokenValue(tokens, cursor + 1) !== '>') return false;
  cursor += 2;
  if (cursor >= end) return false;
  if (tokenValue(tokens, cursor) === '{') {
    return consumeBalanced(tokens, cursor, '{', '}') === end - 1;
  }
  return true;
}

function invalidatedBindings(tokens, bindingDeclarationIndexes) {
  const invalidated = new Set();
  const assignmentPrefixes = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '?']);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== 'word' || bindingDeclarationIndexes.has(index)) continue;
    const next = tokenValue(tokens, index + 1);
    const following = tokenValue(tokens, index + 2);
    const previous = tokenValue(tokens, index - 1);
    const beforePrevious = tokenValue(tokens, index - 2);
    if (
      next === '=' ||
      (assignmentPrefixes.has(next) && following === '=') ||
      (next === '+' && following === '+') ||
      (next === '-' && following === '-') ||
      (previous === '+' && beforePrevious === '+') ||
      (previous === '-' && beforePrevious === '-')
    ) {
      invalidated.add(token.value);
    }
  }
  return invalidated;
}

function parseExportList(tokens, start, sourcePath) {
  const close = consumeBalanced(tokens, start + 1, '{', '}');
  if (close < 0) return null;
  let path = null;
  let end = close + 1;
  if (tokenValue(tokens, end) === 'from') {
    if (tokens[end + 1]?.kind !== 'string') return null;
    path = resolveJavaScriptSpecifier(sourcePath, tokens[end + 1].value);
    if (path === null) return null;
    end += 2;
  }
  if (tokenValue(tokens, end) !== ';') return null;
  const exports = [];
  for (let cursor = start + 2; cursor < close; ) {
    const local = tokens[cursor];
    if (local?.kind !== 'word') return null;
    let exported = local.value;
    cursor += 1;
    if (tokenValue(tokens, cursor) === 'as') {
      if (tokens[cursor + 1]?.kind !== 'word') return null;
      exported = tokens[cursor + 1].value;
      cursor += 2;
    }
    exports.push(Object.freeze({ exported, local: local.value, path }));
    if (cursor < close) {
      if (tokenValue(tokens, cursor) !== ',') return null;
      cursor += 1;
    }
  }
  return Object.freeze({ end: end + 1, exports: Object.freeze(exports), path });
}

function parseEmittedStaticDependencies(source, sourcePath) {
  // The emitted graph can contain arbitrary JavaScript. Use its grammar for
  // edge discovery; the narrow installer tokenizer below only validates the
  // deliberately restricted installation language.
  let program;
  try {
    program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return null;
  }

  const imports = new Set();
  const dynamicImports = new Set();
  const pending = [program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') {
      if (node.source !== null && node.source !== undefined) {
        const path = resolveJavaScriptSpecifier(sourcePath, node.source.value);
        if (path === null) return null;
        imports.add(path);
      }
    } else if (node.type === 'ImportExpression') {
      // Even a resolvable expression is outside the emitted graph contract.
      // Dynamic import options do not affect the source edge.
      if (node.source.type !== 'Literal' || typeof node.source.value !== 'string') return null;
      const path = resolveJavaScriptSpecifier(sourcePath, node.source.value);
      if (path === null) return null;
      dynamicImports.add(path);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child !== null && typeof child === 'object' && typeof child.type === 'string') {
            pending.push(child);
          }
        }
      } else if (value !== null && typeof value === 'object' && typeof value.type === 'string') {
        pending.push(value);
      }
    }
  }
  return Object.freeze({
    imports: Object.freeze([...imports].sort((left, right) => left.localeCompare(right))),
    dynamicImports: Object.freeze(
      [...dynamicImports].sort((left, right) => left.localeCompare(right))
    ),
  });
}

function staticClosure(entryPaths, chunksByPath, edgesByPath) {
  const reachable = new Set();
  const invalid = new Set();
  const pending = [...entryPaths];
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || reachable.has(path)) continue;
    const chunk = chunksByPath.get(path);
    const dependencies = edgesByPath.get(path);
    if (chunk === undefined || dependencies === undefined) {
      invalid.add(path);
      continue;
    }
    reachable.add(path);
    for (const imported of dependencies.imports) {
      if (!chunksByPath.has(imported)) invalid.add(imported);
      else pending.push(imported);
    }
  }
  return Object.freeze({ invalid, reachable });
}

function hasDependencyInitializationHazard(source) {
  const tokens = tokenizeHostedJavaScript(source);
  if (tokens === null) return true;
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokenValue(tokens, index);
    if (depth === 0) {
      if (['throw', 'await', 'if', 'for', 'while', 'switch', 'try', 'with'].includes(token)) {
        return true;
      }
      const directIntrinsic =
        token === 'Object' &&
        tokenValue(tokens, index + 1) === '.' &&
        tokenValue(tokens, index + 2) === 'defineProperty';
      const globalIntrinsic =
        token === 'globalThis' &&
        tokenValue(tokens, index + 1) === '.' &&
        tokenValue(tokens, index + 2) === 'Object' &&
        tokenValue(tokens, index + 3) === '.' &&
        tokenValue(tokens, index + 4) === 'defineProperty';
      const intrinsicEnd = index + (globalIntrinsic ? 5 : 3);
      if (
        (directIntrinsic || globalIntrinsic) &&
        (tokenValue(tokens, intrinsicEnd) === '=' ||
          (tokenValue(tokens, intrinsicEnd) === '(' &&
            tokenValue(tokens, intrinsicEnd + 1) === 'Object' &&
            tokenValue(tokens, intrinsicEnd + 2) === ',' &&
            tokens[intrinsicEnd + 3]?.kind === 'string' &&
            tokens[intrinsicEnd + 3].value === 'defineProperty'))
      ) {
        return true;
      }
      if (
        token === 'Reflect' &&
        tokenValue(tokens, index + 1) === '.' &&
        tokenValue(tokens, index + 2) === 'set' &&
        tokenValue(tokens, index + 3) === '(' &&
        tokenValue(tokens, index + 4) === 'Object' &&
        tokenValue(tokens, index + 5) === ',' &&
        tokens[index + 6]?.kind === 'string' &&
        tokens[index + 6].value === 'defineProperty'
      ) {
        return true;
      }
    }
    if (['{', '(', '['].includes(token)) depth += 1;
    if (['}', ')', ']'].includes(token)) depth -= 1;
    if (depth < 0) return true;
  }
  return depth !== 0;
}

function analyzeModule(source, sourcePath) {
  const tokens = tokenizeHostedJavaScript(source);
  if (tokens === null) return null;
  const imports = parseTopLevelImports(tokens, sourcePath);
  if (imports === null) return null;
  const callableLocals = new Set();
  const bindingDeclarationIndexes = new Set();
  const localAliases = new Map();
  const exports = new Map();
  let depth = 0;

  for (let cursor = 0; cursor < tokens.length; ) {
    const token = tokenValue(tokens, cursor);
    if (depth !== 0) {
      if (['{', '(', '['].includes(token)) depth += 1;
      if (['}', ')', ']'].includes(token)) depth -= 1;
      if (depth < 0) return null;
      cursor += 1;
      continue;
    }

    if (token === 'export') {
      if (tokenValue(tokens, cursor + 1) === '*') return null;
      if (tokenValue(tokens, cursor + 1) === '{') {
        const parsed = parseExportList(tokens, cursor, sourcePath);
        if (parsed === null) return null;
        for (const item of parsed.exports) {
          if (exports.has(item.exported)) return null;
          exports.set(
            item.exported,
            item.path === null
              ? Object.freeze({ kind: 'local', local: item.local })
              : Object.freeze({ exportName: item.local, kind: 'reexport', path: item.path })
          );
        }
        cursor = parsed.end;
        continue;
      }
      const declarationOffset = tokenValue(tokens, cursor + 1) === 'async' ? 2 : 1;
      if (tokenValue(tokens, cursor + declarationOffset) === 'function') {
        const nameOffset = tokenValue(tokens, cursor + declarationOffset + 1) === '*' ? 2 : 1;
        const name = tokens[cursor + declarationOffset + nameOffset];
        if (name?.kind !== 'word' || exports.has(name.value)) return null;
        bindingDeclarationIndexes.add(cursor + declarationOffset + nameOffset);
        callableLocals.add(name.value);
        exports.set(name.value, Object.freeze({ kind: 'local', local: name.value }));
        cursor += declarationOffset;
        continue;
      }
      if (['const', 'let', 'var'].includes(tokenValue(tokens, cursor + 1))) {
        const end = findHostedStatementEnd(tokens, cursor + 1);
        if (end < 0) return null;
        let declaration = cursor + 2;
        while (declaration < end) {
          const name = tokens[declaration];
          if (name?.kind !== 'word' || tokenValue(tokens, declaration + 1) !== '=') return null;
          bindingDeclarationIndexes.add(declaration);
          const valueStart = declaration + 2;
          let valueEnd = valueStart;
          let valueDepth = 0;
          while (valueEnd < end) {
            const valueToken = tokenValue(tokens, valueEnd);
            if (['{', '(', '['].includes(valueToken)) valueDepth += 1;
            if (['}', ')', ']'].includes(valueToken)) valueDepth -= 1;
            if (valueDepth === 0 && valueToken === ',') break;
            valueEnd += 1;
          }
          if (exports.has(name.value)) return null;
          if (isCallableInitializer(tokens, valueStart, valueEnd)) callableLocals.add(name.value);
          else if (valueEnd === valueStart + 1 && tokens[valueStart]?.kind === 'word') {
            localAliases.set(name.value, tokens[valueStart].value);
          }
          exports.set(name.value, Object.freeze({ kind: 'local', local: name.value }));
          declaration = valueEnd + 1;
        }
        cursor = end + 1;
        continue;
      }
      return null;
    }

    const functionOffset = token === 'async' ? 1 : 0;
    if (tokenValue(tokens, cursor + functionOffset) === 'function') {
      const nameOffset = tokenValue(tokens, cursor + functionOffset + 1) === '*' ? 2 : 1;
      const name = tokens[cursor + functionOffset + nameOffset];
      if (name?.kind !== 'word') return null;
      bindingDeclarationIndexes.add(cursor + functionOffset + nameOffset);
      callableLocals.add(name.value);
      cursor += functionOffset + nameOffset + 1;
      continue;
    }

    if (['const', 'let', 'var'].includes(token)) {
      const end = findHostedStatementEnd(tokens, cursor);
      if (end < 0) return null;
      let declaration = cursor + 1;
      while (declaration < end) {
        const name = tokens[declaration];
        if (name?.kind !== 'word' || tokenValue(tokens, declaration + 1) !== '=') break;
        bindingDeclarationIndexes.add(declaration);
        const valueStart = declaration + 2;
        let valueEnd = valueStart;
        let valueDepth = 0;
        while (valueEnd < end) {
          const valueToken = tokenValue(tokens, valueEnd);
          if (['{', '(', '['].includes(valueToken)) valueDepth += 1;
          if (['}', ')', ']'].includes(valueToken)) valueDepth -= 1;
          if (valueDepth === 0 && valueToken === ',') break;
          valueEnd += 1;
        }
        if (isCallableInitializer(tokens, valueStart, valueEnd)) callableLocals.add(name.value);
        else if (valueEnd === valueStart + 1 && tokens[valueStart]?.kind === 'word') {
          localAliases.set(name.value, tokens[valueStart].value);
        }
        declaration = valueEnd + 1;
      }
      cursor = end + 1;
      continue;
    }

    if (['{', '(', '['].includes(token)) depth += 1;
    if (['}', ')', ']'].includes(token)) depth -= 1;
    if (depth < 0) return null;
    cursor += 1;
  }
  if (depth !== 0) return null;
  return Object.freeze({
    callableLocals,
    exports,
    imports: imports.bindings,
    invalidatedLocals: invalidatedBindings(tokens, bindingDeclarationIndexes),
    localAliases,
  });
}

function callableExport(path, exportName, chunksByPath, analyses, resolving) {
  const identity = `${path}\0${exportName}`;
  if (resolving.has(identity)) return false;
  const chunk = chunksByPath.get(path);
  if (!chunk || !chunk.exports.includes(exportName)) return false;
  let analysis = analyses.get(path);
  if (analysis === undefined) {
    analysis = analyzeModule(chunk.source, path);
    analyses.set(path, analysis);
  }
  if (analysis === null) return false;
  const exported = analysis.exports.get(exportName);
  if (exported === undefined) return false;
  const nextResolving = new Set(resolving).add(identity);
  if (exported.kind === 'reexport') {
    return callableExport(
      exported.path,
      exported.exportName,
      chunksByPath,
      analyses,
      nextResolving
    );
  }
  let local = exported.local;
  const localSeen = new Set();
  while (true) {
    if (localSeen.has(local)) return false;
    localSeen.add(local);
    if (analysis.invalidatedLocals.has(local)) return false;
    if (analysis.callableLocals.has(local)) return true;
    const imported = analysis.imports.get(local);
    if (imported) {
      return callableExport(
        imported.path,
        imported.imported,
        chunksByPath,
        analyses,
        nextResolving
      );
    }
    const alias = analysis.localAliases.get(local);
    if (alias === undefined) return false;
    local = alias;
  }
}

function verifyInstaller(entryPath, source, globalName, chunksByPath, requiredApi) {
  const tokens = tokenizeHostedJavaScript(source);
  if (tokens === null) return false;
  const imports = new Map();
  let cursor = 0;
  while (tokenValue(tokens, cursor) === 'import') {
    const parsed = parseNamedImport(tokens, cursor, entryPath);
    if (parsed === null) return false;
    for (const binding of parsed.bindings) {
      if (
        imports.has(binding.local) ||
        binding.local === 'Object' ||
        binding.local === 'globalThis'
      ) {
        return false;
      }
      imports.set(binding.local, binding);
    }
    cursor = parsed.end;
  }
  if (imports.size < requiredApi.length) return false;

  const define = ['Object', '.', 'defineProperty', '(', 'globalThis'];
  const installerStarts = [];
  let delimiterDepth = 0;
  let delimitersBalanced = true;
  for (let index = cursor; index < tokens.length; index += 1) {
    const token = tokenValue(tokens, index);
    if (define.every((value, offset) => tokenValue(tokens, index + offset) === value)) {
      installerStarts.push(index);
    }
    if (
      index < (installerStarts[0] ?? Number.POSITIVE_INFINITY) &&
      ['Object', 'globalThis'].includes(token) &&
      (tokenValue(tokens, index + 1) === '=' ||
        (['const', 'let', 'var', 'class', 'function'].includes(tokenValue(tokens, index - 1)) &&
          tokenValue(tokens, index - 2) !== '.'))
    ) {
      return false;
    }
    if (['{', '(', '['].includes(token)) delimiterDepth += 1;
    if (['}', ')', ']'].includes(token)) delimiterDepth -= 1;
    if (delimiterDepth < 0) delimitersBalanced = false;
  }
  if (installerStarts.length !== 1) return false;
  if (delimitersBalanced && delimiterDepth === 0 && installerStarts[0] !== cursor) return false;
  cursor = installerStarts[0];
  if (
    !define.every((value, index) => tokenValue(tokens, cursor + index) === value) ||
    tokenValue(tokens, cursor + 5) !== ',' ||
    tokens[cursor + 6]?.kind !== 'string' ||
    tokens[cursor + 6].value !== globalName ||
    tokenValue(tokens, cursor + 7) !== ',' ||
    tokenValue(tokens, cursor + 8) !== '{' ||
    tokenValue(tokens, cursor + 9) !== 'value' ||
    tokenValue(tokens, cursor + 10) !== ':' ||
    tokenValue(tokens, cursor + 11) !== '{'
  ) {
    return false;
  }
  cursor += 12;
  const expectedByKey = new Map(requiredApi.map((item) => [item.globalKey, item]));
  const seenKeys = new Set();
  const analyses = new Map();
  while (tokenValue(tokens, cursor) !== '}') {
    const key = tokens[cursor];
    if (key?.kind !== 'word' || seenKeys.has(key.value)) {
      return false;
    }
    const hasExplicitValue = tokenValue(tokens, cursor + 1) === ':';
    const bindingToken = hasExplicitValue ? tokens[cursor + 2] : key;
    if (bindingToken?.kind !== 'word') return false;
    const expected = expectedByKey.get(key.value);
    const binding = imports.get(bindingToken.value);
    const chunk = binding && chunksByPath.get(binding.path);
    if (
      !expected ||
      !binding ||
      !chunk?.moduleIds.includes(expected.moduleId) ||
      !callableExport(binding.path, binding.imported, chunksByPath, analyses, new Set())
    ) {
      return false;
    }
    seenKeys.add(key.value);
    cursor += hasExplicitValue ? 3 : 1;
    if (tokenValue(tokens, cursor) === ',') cursor += 1;
    else if (tokenValue(tokens, cursor) !== '}') return false;
  }
  if (
    seenKeys.size !== requiredApi.length ||
    tokenValue(tokens, cursor + 1) !== '}' ||
    tokenValue(tokens, cursor + 2) !== ')' ||
    tokenValue(tokens, cursor + 3) !== ';'
  ) {
    return false;
  }
  cursor += 4;
  while (cursor < tokens.length) {
    if (tokenValue(tokens, cursor) === ';') {
      cursor += 1;
      continue;
    }
    if (tokenValue(tokens, cursor) !== 'export' || tokenValue(tokens, cursor + 1) !== '{') {
      return false;
    }
    const parsed = parseExportList(tokens, cursor, entryPath);
    if (parsed === null || parsed.path !== null) return false;
    cursor = parsed.end;
  }
  return true;
}

export function inspectHostedBrowserEventStreamProof({
  entryPaths,
  chunks,
  globalName,
  entryModuleId,
  requiredApi,
}) {
  if (
    !Array.isArray(entryPaths) ||
    !Array.isArray(chunks) ||
    !Array.isArray(requiredApi) ||
    typeof globalName !== 'string' ||
    typeof entryModuleId !== 'string'
  ) {
    return Object.freeze({
      reachableChunkPaths: Object.freeze([]),
      violations: Object.freeze(['hosted_renderer_graph_proof_input_invalid']),
    });
  }
  if (
    !chunks.every(
      (chunk) =>
        isRecord(chunk) &&
        typeof chunk.fileName === 'string' &&
        typeof chunk.source === 'string' &&
        Array.isArray(chunk.imports) &&
        chunk.imports.every((path) => typeof path === 'string') &&
        (chunk.dynamicImports === undefined ||
          (Array.isArray(chunk.dynamicImports) &&
            chunk.dynamicImports.every((path) => typeof path === 'string'))) &&
        Array.isArray(chunk.exports) &&
        chunk.exports.every((name) => typeof name === 'string') &&
        Array.isArray(chunk.moduleIds) &&
        chunk.moduleIds.every((id) => typeof id === 'string')
    ) ||
    !requiredApi.every(
      (item) =>
        isRecord(item) && typeof item.globalKey === 'string' && typeof item.moduleId === 'string'
    )
  ) {
    return Object.freeze({
      reachableChunkPaths: Object.freeze([]),
      violations: Object.freeze(['hosted_renderer_graph_emitted_chunk_invalid']),
    });
  }
  const chunksByPath = new Map();
  for (const chunk of chunks) {
    if (chunksByPath.has(chunk.fileName)) {
      return Object.freeze({
        reachableChunkPaths: Object.freeze([]),
        violations: Object.freeze(['hosted_renderer_graph_emitted_chunk_invalid']),
      });
    }
    chunksByPath.set(chunk.fileName, chunk);
  }
  const violations = [];
  const edgesByPath = new Map();
  for (const [path, chunk] of chunksByPath) {
    const edges = parseEmittedStaticDependencies(chunk.source, path);
    const declaredImports = [...chunk.imports].sort((left, right) => left.localeCompare(right));
    const declaredDynamicImports = [...(chunk.dynamicImports ?? [])].sort((left, right) =>
      left.localeCompare(right)
    );
    if (
      edges === null ||
      JSON.stringify(edges.imports) !== JSON.stringify(declaredImports) ||
      JSON.stringify(edges.dynamicImports) !== JSON.stringify(declaredDynamicImports) ||
      [...edges.imports, ...edges.dynamicImports].some((imported) => !chunksByPath.has(imported))
    ) {
      violations.push(`hosted_renderer_graph_emitted_static_edge_invalid:${path}`);
      continue;
    }
    edgesByPath.set(path, edges);
  }
  const htmlClosure = staticClosure(entryPaths, chunksByPath, edgesByPath);
  for (const path of [...htmlClosure.invalid].sort()) {
    violations.push(`hosted_renderer_graph_emitted_static_edge_invalid:${path}`);
  }
  const entries = [...htmlClosure.reachable].filter((path) =>
    chunksByPath.get(path)?.moduleIds.includes(entryModuleId)
  );
  if (entries.length !== 1) {
    violations.push(
      entries.length
        ? `hosted_renderer_graph_proof_entry_html_ambiguous:${entryModuleId}`
        : `hosted_renderer_graph_proof_entry_html_unreachable:${entryModuleId}`
    );
    for (const { moduleId } of requiredApi) {
      violations.push(`hosted_renderer_graph_required_module_unreachable:${moduleId}`);
    }
    violations.push(
      `hosted_renderer_graph_browser_callable_api_installation_missing:${globalName}`
    );
    return Object.freeze({
      reachableChunkPaths: Object.freeze([]),
      violations: Object.freeze(violations),
    });
  }
  const installerClosure = staticClosure(entries, chunksByPath, edgesByPath);
  if (
    [...installerClosure.reachable].some(
      (path) =>
        path !== entries[0] &&
        hasDependencyInitializationHazard(chunksByPath.get(path)?.source ?? '')
    )
  ) {
    violations.push('hosted_renderer_graph_browser_dependency_initialization_unsafe');
  }
  for (const { moduleId } of requiredApi) {
    if (
      ![...htmlClosure.reachable].some((path) =>
        chunksByPath.get(path)?.moduleIds.includes(moduleId)
      )
    ) {
      violations.push(`hosted_renderer_graph_required_module_unreachable:${moduleId}`);
    }
  }
  if (
    !verifyInstaller(
      entries[0],
      chunksByPath.get(entries[0])?.source ?? '',
      globalName,
      chunksByPath,
      requiredApi
    )
  ) {
    violations.push(
      `hosted_renderer_graph_browser_callable_api_installation_missing:${globalName}`
    );
  }
  return Object.freeze({
    reachableChunkPaths: Object.freeze([...htmlClosure.reachable].sort()),
    violations: Object.freeze(violations),
  });
}
