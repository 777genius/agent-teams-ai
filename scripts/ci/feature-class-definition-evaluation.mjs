import ts from 'typescript';

function isStaticClassMember(member) {
  return (
    ts.canHaveModifiers(member) &&
    (ts.getModifiers(member)?.some(({ kind }) => kind === ts.SyntaxKind.StaticKeyword) ?? false)
  );
}

// Class definitions evaluate heritage, decorators, computed keys, static initializers, and
// static blocks immediately. Returns the defining class when `node` is one of those positions.
export function classDefinitionEvaluationOwner(node) {
  const parent = node.parent;
  if (!parent) return null;
  if (ts.isClassLike(parent)) {
    return (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword) ||
      ts.isDecorator(node) ||
      ts.isClassStaticBlockDeclaration(node) ||
      (ts.isPropertyDeclaration(node) && isStaticClassMember(node))
      ? parent
      : null;
  }
  const owner = parent.parent;
  if (!owner || !ts.isClassLike(owner) || !owner.members.includes(parent)) return null;
  if (node === parent.name || ts.isDecorator(node)) return owner;
  return ts.isPropertyDeclaration(parent) &&
    node === parent.initializer &&
    isStaticClassMember(parent)
    ? owner
    : null;
}

export function isInsideClass(node, sourceFile) {
  for (let current = node.parent; current && current !== sourceFile; current = current.parent) {
    if (ts.isClassLike(current)) return true;
  }
  return false;
}
