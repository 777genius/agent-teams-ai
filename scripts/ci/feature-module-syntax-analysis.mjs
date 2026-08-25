import ts from 'typescript';

export function forEachChildIncludingJsDoc(node, visit) {
  for (const jsDoc of node.jsDoc ?? []) visit(jsDoc);
  ts.forEachChild(node, visit);
}

export function importDeclarationIsTypeOnly(node) {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    !clause.name &&
    bindings &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every(({ isTypeOnly }) => isTypeOnly)
  );
}
