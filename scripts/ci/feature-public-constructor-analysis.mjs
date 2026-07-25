import ts from 'typescript';

import { memberAccess, propertyNameText } from './feature-export-analysis.mjs';

function isPublicInstanceMember(node) {
  if (!node.name || ts.isPrivateIdentifier(node.name)) return false;
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !modifiers?.some(
    ({ kind }) =>
      kind === ts.SyntaxKind.PrivateKeyword ||
      kind === ts.SyntaxKind.ProtectedKeyword ||
      kind === ts.SyntaxKind.StaticKeyword
  );
}

function isPublicInstanceAssignment(targetExpression, boundary) {
  if (
    ts.isPropertyAccessExpression(targetExpression) &&
    ts.isPrivateIdentifier(targetExpression.name)
  ) {
    return null;
  }
  const target = memberAccess(targetExpression);
  if (!target || target.receiver.kind !== ts.SyntaxKind.ThisKeyword) return null;
  if (
    ts.isClassLike(boundary) &&
    boundary.members.some(
      (member) =>
        member.name &&
        propertyNameText(member.name) === target.name &&
        !isPublicInstanceMember(member)
    )
  ) {
    return null;
  }
  return target.name;
}

export function publicConstructorSelection(reference, boundary) {
  let current = reference;
  let returned = false;
  while (current.parent && current.parent !== boundary) {
    const parent = current.parent;
    if (ts.isReturnStatement(parent)) returned = true;
    if (
      ts.isBinaryExpression(parent) &&
      ts.isAssignmentOperator(parent.operatorToken.kind) &&
      parent.right === current
    ) {
      const localMember = isPublicInstanceAssignment(parent.left, boundary);
      if (localMember !== null) {
        return { getterOnly: false, localMember };
      }
    }
    if (
      (ts.isPropertyDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isMethodDeclaration(parent)) &&
      isPublicInstanceMember(parent) &&
      (ts.isPropertyDeclaration(parent) || returned)
    ) {
      return { getterOnly: false, localMember: propertyNameText(parent.name) };
    }
    if (ts.isFunctionLike(parent)) returned = false;
    current = parent;
  }
  return null;
}
