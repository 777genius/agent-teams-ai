export type TranslationCatalogNode = string | { readonly [key: string]: TranslationCatalogNode };

export interface CatalogValidationIssue {
  readonly type:
    | 'missing-namespace'
    | 'missing-key'
    | 'extra-key'
    | 'shape-mismatch'
    | 'empty-message'
    | 'interpolation-mismatch';
  readonly locale: string;
  readonly namespace: string;
  readonly key?: string;
  readonly message: string;
}

export type TranslationCatalogByNamespace = Record<string, TranslationCatalogNode>;

export type TranslationCatalogsByLocale = Record<string, TranslationCatalogByNamespace>;

export function validateCatalogCompleteness(
  catalogsByLocale: TranslationCatalogsByLocale,
  sourceLocale: string
): CatalogValidationIssue[] {
  const sourceCatalog = catalogsByLocale[sourceLocale];
  if (!sourceCatalog) {
    return [
      {
        type: 'missing-namespace',
        locale: sourceLocale,
        namespace: '*',
        message: `Source locale "${sourceLocale}" is missing`,
      },
    ];
  }

  const issues: CatalogValidationIssue[] = [];
  for (const [locale, localeCatalog] of Object.entries(catalogsByLocale)) {
    compareLocaleCatalog(issues, locale, localeCatalog, sourceCatalog);
  }
  return issues;
}

function compareLocaleCatalog(
  issues: CatalogValidationIssue[],
  locale: string,
  localeCatalog: TranslationCatalogByNamespace,
  sourceCatalog: TranslationCatalogByNamespace
): void {
  for (const [namespace, sourceNamespaceCatalog] of Object.entries(sourceCatalog)) {
    const targetNamespaceCatalog = localeCatalog[namespace];
    if (!targetNamespaceCatalog) {
      issues.push({
        type: 'missing-namespace',
        locale,
        namespace,
        message: `Locale "${locale}" is missing namespace "${namespace}"`,
      });
      continue;
    }

    compareCatalogNode(issues, {
      locale,
      namespace,
      keyPath: [],
      sourceNode: sourceNamespaceCatalog,
      targetNode: targetNamespaceCatalog,
    });
  }

  for (const namespace of Object.keys(localeCatalog)) {
    if (!(namespace in sourceCatalog)) {
      issues.push({
        type: 'extra-key',
        locale,
        namespace,
        message: `Locale "${locale}" has extra namespace "${namespace}"`,
      });
    }
  }
}

interface CompareCatalogNodeInput {
  readonly locale: string;
  readonly namespace: string;
  readonly keyPath: readonly string[];
  readonly sourceNode: TranslationCatalogNode;
  readonly targetNode: TranslationCatalogNode;
}

function compareCatalogNode(
  issues: CatalogValidationIssue[],
  input: CompareCatalogNodeInput
): void {
  const key = input.keyPath.join('.');

  if (typeof input.sourceNode === 'string') {
    validateStringNode(issues, input, key);
    return;
  }

  if (typeof input.targetNode === 'string') {
    issues.push({
      type: 'shape-mismatch',
      locale: input.locale,
      namespace: input.namespace,
      key,
      message: `Expected object at "${input.namespace}:${key}"`,
    });
    return;
  }

  for (const [childKey, sourceChildNode] of Object.entries(input.sourceNode)) {
    if (!(childKey in input.targetNode)) {
      const missingKey = [...input.keyPath, childKey].join('.');
      issues.push({
        type: 'missing-key',
        locale: input.locale,
        namespace: input.namespace,
        key: missingKey,
        message: `Missing key "${input.namespace}:${missingKey}" for locale "${input.locale}"`,
      });
      continue;
    }

    compareCatalogNode(issues, {
      locale: input.locale,
      namespace: input.namespace,
      keyPath: [...input.keyPath, childKey],
      sourceNode: sourceChildNode,
      targetNode: input.targetNode[childKey],
    });
  }

  for (const childKey of Object.keys(input.targetNode)) {
    if (!(childKey in input.sourceNode)) {
      const extraKey = [...input.keyPath, childKey].join('.');
      issues.push({
        type: 'extra-key',
        locale: input.locale,
        namespace: input.namespace,
        key: extraKey,
        message: `Extra key "${input.namespace}:${extraKey}" for locale "${input.locale}"`,
      });
    }
  }
}

function validateStringNode(
  issues: CatalogValidationIssue[],
  input: CompareCatalogNodeInput,
  key: string
): void {
  const sourceMessage = input.sourceNode;
  if (typeof sourceMessage !== 'string') {
    return;
  }

  if (typeof input.targetNode !== 'string') {
    issues.push({
      type: 'shape-mismatch',
      locale: input.locale,
      namespace: input.namespace,
      key,
      message: `Expected string at "${input.namespace}:${key}"`,
    });
    return;
  }

  if (input.targetNode.trim().length === 0) {
    issues.push({
      type: 'empty-message',
      locale: input.locale,
      namespace: input.namespace,
      key,
      message: `Empty message at "${input.namespace}:${key}" for locale "${input.locale}"`,
    });
  }

  const sourceVariables = extractInterpolationVariables(sourceMessage);
  const targetVariables = extractInterpolationVariables(input.targetNode);
  if (!hasSameItems(sourceVariables, targetVariables)) {
    issues.push({
      type: 'interpolation-mismatch',
      locale: input.locale,
      namespace: input.namespace,
      key,
      message: `Interpolation variables differ at "${input.namespace}:${key}" for locale "${input.locale}"`,
    });
  }
}

export function extractInterpolationVariables(message: string): readonly string[] {
  const variables = new Set<string>();
  for (const match of message.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) {
    variables.add(match[1]);
  }
  return [...variables].sort();
}

function hasSameItems(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
