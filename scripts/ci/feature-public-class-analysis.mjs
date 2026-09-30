import ts from 'typescript';

import {
  containsReference,
  memberAccess,
  propertyNameText,
  unwrapExpression,
} from './feature-export-ast.mjs';
import { visitDefiniteBlockExpressions } from './feature-definite-execution.mjs';

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

function declaredStaticMember(boundary, name) {
  return boundary.members.find(
    (member) =>
      member.name &&
      hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
      propertyNameText(member.name) === name
  );
}

function containingStaticBlock(reference, boundary) {
  let current = reference.parent;
  while (current && current !== boundary) {
    if (ts.isClassStaticBlockDeclaration(current) && current.parent === boundary) return current;
    current = current.parent;
  }
  return null;
}

function isLexicalStaticThis(expression, staticBlock) {
  const current = unwrapExpression(expression);
  if (current.kind !== ts.SyntaxKind.ThisKeyword) return false;
  let parent = current.parent;
  while (parent && parent !== staticBlock) {
    if (ts.isClassLike(parent)) return false;
    if (ts.isFunctionLike(parent) && !ts.isArrowFunction(parent)) return false;
    parent = parent.parent;
  }
  return parent === staticBlock;
}

function publicStaticAssignmentName(targetExpression, boundary, staticBlock) {
  const target = unwrapExpression(targetExpression);
  if (ts.isPropertyAccessExpression(target) && ts.isPrivateIdentifier(target.name)) {
    return null;
  }

  const access =
    memberAccess(target) ??
    (ts.isElementAccessExpression(target)
      ? { name: '*', receiver: unwrapExpression(target.expression) }
      : null);
  if (!access || !isLexicalStaticThis(access.receiver, staticBlock)) return null;
  if (access.name === '*') return '*';

  const declared = declaredStaticMember(boundary, access.name);
  return !declared || isPublicStaticMember(declared) ? access.name : null;
}

const definiteStaticAssignments = new WeakMap();

function staticBlockAssignmentSelection(reference, boundary) {
  const staticBlock = containingStaticBlock(reference, boundary);
  if (!staticBlock) return null;

  let assignments = definiteStaticAssignments.get(staticBlock);
  if (!assignments) {
    assignments = [];
    visitDefiniteBlockExpressions(staticBlock.body, (node) => {
      if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
        assignments.push(node);
      }
    });
    definiteStaticAssignments.set(staticBlock, assignments);
  }

  for (const assignment of assignments) {
    if (!containsReference(assignment.right, reference)) continue;
    const localMember = publicStaticAssignmentName(assignment.left, boundary, staticBlock);
    if (localMember !== null) return { getterOnly: false, localMember };
  }
  return null;
}

export function publicStaticClassSelection(reference, boundary) {
  const assignmentSelection = staticBlockAssignmentSelection(reference, boundary);
  if (assignmentSelection) return assignmentSelection;

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
