import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import ts from 'typescript';

import {
  API_SURFACES,
  type AbsenceRow,
  type ApiSurface,
  CLIENT_ACCESSORS,
  CLIENT_SURFACES,
  CONTROL_SCOPE_PREFIXES,
  type ChildControlCatalog,
  type ControlSite,
  IMPLICIT_CONTROLS,
  INTERNAL_IMPORT_PREFIXES,
  isEventProp,
  LEGACY_CHILD_API_ACTION_IDS,
  MOUNT_CHAINS,
  normalized,
  REVIEWED_CONTROL_FILES,
  type SemanticRow,
  sha,
  type SourceRef,
} from './parity-scan-contracts';

export function scanApiInterfaces(
  sourceText: string
): Array<{ surface: ApiSurface; member: string; signature: string; signatureHash: string }> {
  const source = ts.createSourceFile(
    'api.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const printer = ts.createPrinter({ removeComments: true });
  const rows: Array<{
    surface: ApiSurface;
    member: string;
    signature: string;
    signatureHash: string;
  }> = [];
  for (const statement of source.statements) {
    if (
      !ts.isInterfaceDeclaration(statement) ||
      !API_SURFACES.includes(statement.name.text as ApiSurface)
    )
      continue;
    const surface = statement.name.text as ApiSurface;
    for (const member of statement.members) {
      if ((!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) || !member.name)
        continue;
      const name = member.name.getText(source).replace(/^['"]|['"]$/g, '');
      const signature = normalized(printer.printNode(ts.EmitHint.Unspecified, member, source));
      rows.push({ surface, member: name, signature, signatureHash: `sha256:${sha(signature)}` });
    }
  }
  return rows;
}

export function jsxElement(node: ts.JsxAttribute): string {
  const parent = node.parent.parent;
  return ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)
    ? parent.tagName.getText()
    : 'unknown';
}

export function scanControls(sourceText: string, file: string): ControlSite[] {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const rows: ControlSite[] = [];
  const externalComponentRoots = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    if (INTERNAL_IMPORT_PREFIXES.some((prefix) => moduleSpecifier.startsWith(prefix))) continue;
    const clause = statement.importClause;
    if (!clause?.isTypeOnly && clause?.name) externalComponentRoots.add(clause.name.text);
    if (!clause?.isTypeOnly && clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        externalComponentRoots.add(clause.namedBindings.name.text);
      } else {
        for (const specifier of clause.namedBindings.elements) {
          if (!specifier.isTypeOnly) externalComponentRoots.add(specifier.name.text);
        }
      }
    }
  }
  const isInteractionProp = (element: string, prop: string): boolean =>
    isEventProp(prop) ||
    (/^on[A-Z]/.test(prop) && externalComponentRoots.has(element.split('.')[0]));
  const classifyEffects = (
    initializer: ts.JsxAttributeValue | undefined
  ): ControlSite['effects'] => {
    if (!initializer) return ['semantic'];
    let containment = false;
    let semantic = false;
    const visitEffect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const method =
          ts.isPropertyAccessExpression(expression) || ts.isPropertyAccessChain(expression)
            ? expression.name.text
            : undefined;
        if (
          method &&
          ['preventDefault', 'stopImmediatePropagation', 'stopPropagation'].includes(method)
        ) {
          containment = true;
        } else {
          semantic = true;
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        semantic = true;
      } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
        semantic = true;
      }
      ts.forEachChild(node, visitEffect);
    };
    visitEffect(initializer);
    // A referenced callback is an opaque semantic effect at the JSX boundary. Inline handlers that
    // only contain propagation/default suppression remain deliberate absences.
    if (!containment && !semantic) semantic = true;
    return [containment ? 'containment' : undefined, semantic ? 'semantic' : undefined].filter(
      (effect): effect is 'containment' | 'semantic' => effect !== undefined
    );
  };
  const add = (
    element: string,
    prop: string,
    text: string,
    effects: ControlSite['effects'] = ['semantic']
  ): void => {
    const clean = normalized(text);
    rows.push({
      file,
      element,
      prop,
      text: clean,
      sourceHash: sha(`${element}|${prop}|${clean}`, 16),
      effects,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && isInteractionProp(jsxElement(node), node.name.getText(source))) {
      add(
        jsxElement(node),
        node.name.getText(source),
        node.initializer?.getText(source) ?? '',
        classifyEffects(node.initializer)
      );
    }
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      IMPLICIT_CONTROLS.has(node.tagName.getText(source))
    ) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const names = new Set(attributes.map((attribute) => attribute.name.getText(source)));
      const element = node.tagName.getText(source);
      if (![...names].some((name) => isInteractionProp(element, name)) && !names.has('asChild')) {
        add(element, element === 'a' ? 'navigate' : 'implicitAction', node.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return rows;
}

export function importedModuleSpecifiers(sourceText: string, file: string): string[] {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const specifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    const followsChangeReviewPublicExport =
      file.startsWith('src/features/change-review/renderer/') && ts.isExportDeclaration(node);
    if (
      (ts.isImportDeclaration(node) || followsChangeReviewPublicExport) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...specifiers].sort();
}

export function resolveImportedModule(
  from: string,
  specifier: string,
  readSource: (path: string) => string | undefined
): string | undefined {
  const base = (
    specifier === '@renderer'
      ? 'src/renderer'
      : specifier.startsWith('@renderer/')
        ? `src/renderer/${specifier.slice('@renderer/'.length)}`
        : specifier === '@features'
          ? 'src/features'
          : specifier.startsWith('@features/')
            ? `src/features/${specifier.slice('@features/'.length)}`
            : specifier.startsWith('.')
              ? join(dirname(from), specifier)
              : ''
  ).replaceAll('\\', '/');
  if (!base) return undefined;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts').replaceAll('\\', '/'),
    join(base, 'index.tsx').replaceAll('\\', '/'),
  ];
  return candidates.find((candidate) => readSource(candidate) !== undefined);
}

export function discoverControlClosure(
  roots: readonly string[],
  readSource: (path: string) => string | undefined
): string[] {
  const pending = [...roots];
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.shift()!;
    if (visited.has(file)) continue;
    const source = readSource(file);
    if (source === undefined) throw new Error(`Missing reachable control module: ${file}`);
    visited.add(file);
    for (const specifier of importedModuleSpecifiers(source, file)) {
      const imported = resolveImportedModule(file, specifier, readSource);
      if (!imported || !CONTROL_SCOPE_PREFIXES.some((prefix) => imported.startsWith(prefix)))
        continue;
      if (!visited.has(imported)) pending.push(imported);
    }
  }
  return [...visited].filter((file) => file.endsWith('.tsx')).sort();
}

export function validateMountedControlRoots(
  readSource: (path: string) => string | undefined
): Array<{ root: string; mountChain: string[] }> {
  return MOUNT_CHAINS.map(({ root, edges }) => {
    for (const edge of edges) {
      const source = readSource(edge.from);
      if (source === undefined) throw new Error(`Missing mount module: ${edge.from}`);
      const importsTarget = importedModuleSpecifiers(source, edge.from).some(
        (specifier) => resolveImportedModule(edge.from, specifier, readSource) === edge.to
      );
      if (!importsTarget || !source.includes(`<${edge.component}`)) {
        throw new Error(
          `Mounted control root is not reachable through ${edge.from} -> ${edge.to} (${edge.component})`
        );
      }
    }
    return { root, mountChain: edges.map((edge) => `${edge.from}#${edge.component}`) };
  });
}

export function validateControlClosure(discovered: string[], declared: string[]): void {
  const expected = [...new Set(discovered)].sort();
  const actual = [...new Set(declared)].sort();
  if (actual.length !== declared.length)
    throw new Error('Control closure contains duplicate files');
  const missing = expected.filter((file) => !actual.includes(file));
  const extra = actual.filter((file) => !expected.includes(file));
  if (missing.length || extra.length) {
    throw new Error(
      `Control closure mismatch; missing=[${missing.join(',')}]; extra=[${extra.join(',')}]`
    );
  }
}

export function validateChildControlCatalog(
  sites: ControlSite[],
  catalog: ChildControlCatalog,
  knownActionIds: ReadonlySet<string> = new Set(),
  knownAbsenceIds: ReadonlySet<string> = new Set()
): void {
  const actualByKey = new Map<string, number>();
  for (const site of sites) {
    const key = `${site.file}#sha256:${site.sourceHash}`;
    actualByKey.set(key, (actualByKey.get(key) ?? 0) + 1);
  }
  for (const [key, encoded] of Object.entries(catalog.mappings)) {
    const separator = encoded.indexOf('|');
    const siteCount = Number(encoded.slice(0, separator));
    const actionId = encoded.slice(separator + 1);
    if (separator < 1 || !Number.isInteger(siteCount) || siteCount < 1 || !actionId) {
      throw new Error(`Invalid child control mapping encoding: ${key}`);
    }
    if (
      !catalog.actions[actionId] &&
      !catalog.absences[actionId] &&
      !knownActionIds.has(actionId) &&
      !knownAbsenceIds.has(actionId)
    ) {
      throw new Error(`Child control mapping references an unknown disposition: ${actionId}`);
    }
    if (actualByKey.get(key) !== siteCount) {
      throw new Error(`Child control reference is stale: ${key}`);
    }
  }
  const reviewedFiles = new Set<string>(Object.values(REVIEWED_CONTROL_FILES));
  for (const key of actualByKey.keys()) {
    const hashSeparator = key.lastIndexOf('#sha256:');
    const file = key.slice(0, hashSeparator);
    if (!reviewedFiles.has(file) && !(key in catalog.mappings)) {
      throw new Error(`Missing child control mapping: ${key}`);
    }
  }
}

export function childCatalogRefs(catalog: ChildControlCatalog, dispositionId: string): SourceRef[] {
  return Object.entries(catalog.mappings)
    .filter(([, encoded]) => encoded.slice(encoded.indexOf('|') + 1) === dispositionId)
    .map(([key, encoded]) => {
      const hashSeparator = key.lastIndexOf('#sha256:');
      return {
        file: key.slice(0, hashSeparator),
        sourceHash: key.slice(hashSeparator + 1),
        siteCount: Number(encoded.slice(0, encoded.indexOf('|'))),
      };
    })
    .sort((left, right) =>
      `${left.file}#${left.sourceHash}`.localeCompare(`${right.file}#${right.sourceHash}`)
    );
}

export function childCatalogActions(catalog: ChildControlCatalog): SemanticRow[] {
  const refsByAction = new Map<string, SourceRef[]>();
  for (const [key, encoded] of Object.entries(catalog.mappings)) {
    const separator = encoded.indexOf('|');
    const siteCount = Number(encoded.slice(0, separator));
    const actionId = encoded.slice(separator + 1);
    const hashSeparator = key.lastIndexOf('#sha256:');
    const file = key.slice(0, hashSeparator);
    const sourceHash = key.slice(hashSeparator + 1);
    const current = refsByAction.get(actionId) ?? [];
    current.push({ file, sourceHash, siteCount });
    refsByAction.set(actionId, current);
  }
  return Object.entries(catalog.actions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, encoded]) => {
      const [owner, disposition, securityClass, target, ...evidence] = encoded.split('|');
      if (
        !owner ||
        !['direct', 'decomposed', 'desktop-only', 'deferred'].includes(disposition) ||
        !securityClass ||
        !target ||
        !evidence.length
      ) {
        throw new Error(`Invalid child action encoding for ${id}`);
      }
      const sourceRefs = refsByAction.get(id) ?? [];
      if (!sourceRefs.length) throw new Error(`Unused child action: ${id}`);
      return {
        id,
        owner,
        disposition: disposition as SemanticRow['disposition'],
        securityClass,
        target,
        evidence,
        sourceRefs: sourceRefs.sort((left, right) =>
          `${left.file}#${left.sourceHash}`.localeCompare(`${right.file}#${right.sourceHash}`)
        ),
      };
    });
}

export function childCatalogAbsences(catalog: ChildControlCatalog): AbsenceRow[] {
  const refsByAbsence = new Map<string, SourceRef[]>();
  for (const [key, encoded] of Object.entries(catalog.mappings)) {
    const separator = encoded.indexOf('|');
    const siteCount = Number(encoded.slice(0, separator));
    const absenceId = encoded.slice(separator + 1);
    if (!catalog.absences[absenceId]) continue;
    const hashSeparator = key.lastIndexOf('#sha256:');
    const file = key.slice(0, hashSeparator);
    const sourceHash = key.slice(hashSeparator + 1);
    const current = refsByAbsence.get(absenceId) ?? [];
    current.push({ file, sourceHash, siteCount });
    refsByAbsence.set(absenceId, current);
  }
  return Object.entries(catalog.absences)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, reason]) => {
      const sourceRefs = refsByAbsence.get(id) ?? [];
      if (!sourceRefs.length) throw new Error(`Unused child absence: ${id}`);
      return {
        id,
        reason,
        sourceRefs: sourceRefs.sort((left, right) =>
          `${left.file}#${left.sourceHash}`.localeCompare(`${right.file}#${right.sourceHash}`)
        ),
      };
    });
}

export function validateLegacyChildApiActionMappings(
  actions: SemanticRow[],
  apiActions: Array<{ actionId: string; owningFeature: string }>
): Array<{ childActionId: string; apiActionId: string; owner: string }> {
  const childActions = new Map(actions.map((action) => [action.id, action]));
  const apiOwners = new Map(apiActions.map((action) => [action.actionId, action.owningFeature]));

  return Object.entries(LEGACY_CHILD_API_ACTION_IDS).map(([childActionId, apiActionId]) => {
    const childAction = childActions.get(childActionId);
    if (!childAction) throw new Error(`Missing API-linked child action: ${childActionId}`);
    const apiOwner = apiOwners.get(apiActionId);
    if (!apiOwner) throw new Error(`Missing API action for child mapping: ${apiActionId}`);
    if (childAction.owner !== apiOwner) {
      throw new Error(
        `Child/API ownership conflict: ${childActionId} (${childAction.owner}) -> ${apiActionId} (${apiOwner})`
      );
    }
    return { childActionId, apiActionId, owner: apiOwner };
  });
}

export function refsFor(
  repoRoot: string,
  refs: Array<[keyof typeof REVIEWED_CONTROL_FILES, string]>,
  sites: ControlSite[]
): SourceRef[] {
  return refs.map(([key, sourceHash]) => {
    const file = REVIEWED_CONTROL_FILES[key];
    const siteCount = sites.filter(
      (site) => site.file === file && site.sourceHash === sourceHash
    ).length;
    if (!siteCount) throw new Error(`Reviewed source reference disappeared: ${file}#${sourceHash}`);
    if (!existsSync(join(repoRoot, file))) throw new Error(`Missing reviewed source file: ${file}`);
    return { file, sourceHash: `sha256:${sourceHash}`, siteCount };
  });
}

export function validateSemanticCatalog(
  sites: ControlSite[],
  actions: SemanticRow[],
  absences: AbsenceRow[]
): void {
  const ids = [...actions.map((row) => row.id), ...absences.map((row) => row.id)];
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate semantic action/absence ID');
  for (const action of actions) {
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(action.id))
      throw new Error(`Non-canonical action ID: ${action.id}`);
  }
  const mapped = new Map<string, number>();
  const mappedDisposition = new Map<string, 'action' | 'absence'>();
  for (const row of [...actions, ...absences])
    for (const ref of row.sourceRefs) {
      const key = `${ref.file}#${ref.sourceHash.replace('sha256:', '')}`;
      if (mapped.has(key)) throw new Error(`Source reference assigned twice: ${key}`);
      mapped.set(key, ref.siteCount);
      mappedDisposition.set(key, 'reason' in row ? 'absence' : 'action');
    }
  const actual = new Map<string, number>();
  for (const site of sites) {
    const key = `${site.file}#${site.sourceHash}`;
    actual.set(key, (actual.get(key) ?? 0) + 1);
  }
  for (const [key, count] of actual)
    if (mapped.get(key) !== count) throw new Error(`Missing or stale semantic mapping: ${key}`);
  for (const site of sites) {
    const key = `${site.file}#${site.sourceHash}`;
    if (
      site.effects.includes('containment') &&
      site.effects.includes('semantic') &&
      mappedDisposition.get(key) === 'absence'
    ) {
      throw new Error(`Mixed containment/semantic handler must map to a semantic action: ${key}`);
    }
  }
  for (const key of mapped.keys())
    if (!actual.has(key)) throw new Error(`Catalog reference has no source site: ${key}`);
}

export function validateApiDispositions(
  apiRows: ReturnType<typeof scanApiInterfaces>,
  dispositions: Array<{ source: ApiSurface; sourceMember: string }>
): void {
  const expected = apiRows.map((row) => `${row.surface}.${row.member}`).sort();
  const actual = dispositions.map((row) => `${row.source}.${row.sourceMember}`).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error('API dispositions must contain every pinned member exactly once');
  }
}

export function findDynamicDispatch(sourceText: string): string[] {
  const dynamic = [
    ...sourceText.matchAll(/api\.(?:teams|review|crossTeam)\s*\[\s*([^'"\]]+?)\s*\]/g),
  ];
  return dynamic
    .filter(
      (match) =>
        !sourceText
          .slice(Math.max(0, match.index! - 160), match.index)
          .includes('@hosted-web-dynamic-action')
    )
    .map((match) => match[0]);
}

export function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function scanRendererApiCallers(
  sourceText: string
): { surface: ApiSurface; member: string }[] {
  const callers: { surface: ApiSurface; member: string }[] = [];
  for (const surface of API_SURFACES) {
    const client = CLIENT_SURFACES[surface];
    const accessor = CLIENT_ACCESSORS[surface];
    const expression = new RegExp(
      `(?:(?:api|window\\.electronAPI)\\.${client}|${accessor}\\(\\))\\.([A-Za-z_$][\\w$]*)`,
      'g'
    );
    for (const match of sourceText.matchAll(expression)) {
      callers.push({ surface, member: match[1] });
    }
  }
  return callers;
}

export function rendererCallers(repoRoot: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const absolute of [
    ...walk(join(repoRoot, 'src/renderer')),
    ...walk(join(repoRoot, 'src/features')),
  ].filter((file) => /\.tsx?$/.test(file))) {
    const text = readFileSync(absolute, 'utf8');
    for (const { surface, member } of scanRendererApiCallers(text)) {
      const key = `${surface}.${member}`;
      if (!result.has(key)) result.set(key, new Set());
      result.get(key)!.add(relative(repoRoot, absolute));
    }
    if (findDynamicDispatch(text).length)
      throw new Error(`Unannotated dynamic API dispatch: ${relative(repoRoot, absolute)}`);
  }
  return result;
}

export function bypassEvidence(repoRoot: string): {
  summary: Record<string, number>;
  rows: Array<{ id: string; kind: string; path: string; sourceHash: string }>;
} {
  const rules = [
    ['direct-electron-global', /window\.electronAPI\.teams/g],
    ['global-mega-client-call', /\bapi\.(?:teams|review|crossTeam)\./g],
    [
      'structural-capability-check',
      /(?:typeof\s+[^\n]+===\s*['"]function|\?\.(?:teams|review|crossTeam))/g,
    ],
    [
      'fabricated-browser-success',
      /(?:not available in browser mode|return\s+\[\]|return\s+\{\}|no-op)/gi,
    ],
  ] as const;
  const rows: Array<{ id: string; kind: string; path: string; sourceHash: string }> = [];
  for (const absolute of [
    ...walk(join(repoRoot, 'src/renderer')),
    ...walk(join(repoRoot, 'src/features')),
  ].filter((file) => /\.tsx?$/.test(file))) {
    const text = readFileSync(absolute, 'utf8');
    const path = relative(repoRoot, absolute);
    for (const [kind, pattern] of rules)
      for (const match of text.matchAll(pattern)) {
        const context = normalized(
          text.slice(
            Math.max(0, match.index! - 80),
            Math.min(text.length, match.index! + match[0].length + 80)
          )
        );
        const sourceHash = `sha256:${sha(context)}`;
        rows.push({
          id: `P0.W1.BYPASS.${sha(`${kind}:${path}:${sourceHash}`, 16)}`,
          kind,
          path,
          sourceHash,
        });
      }
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const summary = Object.fromEntries(
    rules.map(([kind]) => [kind, rows.filter((row) => row.kind === kind).length])
  );
  return { summary, rows };
}
