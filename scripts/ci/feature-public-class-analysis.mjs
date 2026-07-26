import ts from 'typescript';

import { propertyNameText } from './feature-export-ast.mjs';

function hasModifier(node, kind) {
  return (
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind)
  );
}

function isPublicStaticMember(member) {
  return (
    member.name &&
    !ts.isPrivateIdentifier(member.name) &&
    hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
    !hasModifier(member, ts.SyntaxKind.PrivateKeyword) &&
    !hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
  );
}

export function publicStaticClassSelection(reference, boundary) {
  let current = reference;
  let returned = false;
  while (current.parent && current.parent !== boundary) {
    const parent = current.parent;
    if (ts.isReturnStatement(parent)) returned = true;
    if (
      (ts.isPropertyDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isMethodDeclaration(parent)) &&
      parent.parent === boundary &&
      isPublicStaticMember(parent)
    ) {
      const outsideBody =
        !parent.body || reference.pos < parent.body.pos || reference.end > parent.body.end;
      if (ts.isPropertyDeclaration(parent) || returned || outsideBody) {
        return { getterOnly: false, localMember: propertyNameText(parent.name) };
      }
    }
    if (ts.isFunctionLike(parent)) returned = false;
    current = parent;
  }
  return null;
}
