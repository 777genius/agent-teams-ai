import ts from 'typescript';

import { LOGICAL_ASSIGNMENT_KINDS } from './feature-assignment-operators.mjs';
import { containsReference, unwrapExpression } from './feature-export-ast.mjs';
import { isUnshadowedGlobalValueReference } from './feature-lexical-binding-analysis.mjs';

const VALUE_PRESERVING_BINARY_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

function isUnshadowedBooleanCall(call) {
  const callee = unwrapExpression(call.expression);
  return (
    ts.isIdentifier(callee) && callee.text === 'Boolean' && isUnshadowedGlobalValueReference(callee)
  );
}

export function publishedValueReferenceState(expression, reference) {
  if (!containsReference(expression, reference)) return 'unknown';
  let current = reference;
  let returned = false;

  while (current !== expression) {
    const parent = current.parent;
    if (!parent || !containsReference(parent, reference)) return 'unknown';
    if (
      ((ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isAwaitExpression(parent)) &&
        parent.expression === current) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadAssignment(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isJsxExpression(parent)
    ) {
      current = parent;
      continue;
    }
    if (ts.isPropertyAssignment(parent)) {
      if (!containsReference(parent.initializer, reference)) return 'scalarized';
      current = parent;
      continue;
    }
    if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
      if (!containsReference(parent.expression, reference)) return 'scalarized';
      current = parent;
      continue;
    }
    if (ts.isConditionalExpression(parent)) {
      if (containsReference(parent.condition, reference)) return 'scalarized';
      current = parent;
      continue;
    }
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind;
      if (operator === ts.SyntaxKind.CommaToken) {
        if (!containsReference(parent.right, reference)) return 'scalarized';
      } else if (operator === ts.SyntaxKind.EqualsToken || LOGICAL_ASSIGNMENT_KINDS.has(operator)) {
        if (!containsReference(parent.right, reference)) return 'scalarized';
      } else if (!VALUE_PRESERVING_BINARY_OPERATORS.has(operator)) {
        return 'scalarized';
      }
      current = parent;
      continue;
    }
    if (ts.isCallExpression(parent)) {
      if (
        parent.arguments.some((argument) => containsReference(argument, reference)) &&
        isUnshadowedBooleanCall(parent)
      ) {
        return 'scalarized';
      }
      current = parent;
      continue;
    }
    if (ts.isNewExpression(parent) || ts.isTaggedTemplateExpression(parent)) {
      current = parent;
      continue;
    }
    if (ts.isReturnStatement(parent) || ts.isYieldExpression(parent)) {
      returned = true;
      current = parent;
      continue;
    }
    if (
      returned &&
      (ts.isBlock(parent) ||
        ts.isCaseClause(parent) ||
        ts.isDefaultClause(parent) ||
        ts.isIfStatement(parent) ||
        ts.isSwitchStatement(parent) ||
        ts.isTryStatement(parent) ||
        ts.isCatchClause(parent) ||
        ts.isLabeledStatement(parent))
    ) {
      current = parent;
      continue;
    }
    if (
      ts.isFunctionLike(parent) &&
      parent === unwrapExpression(expression) &&
      (returned || parent.body === current)
    ) {
      returned = false;
      current = parent;
      continue;
    }
    if (
      ts.isPrefixUnaryExpression(parent) ||
      ts.isPostfixUnaryExpression(parent) ||
      ts.isTypeOfExpression(parent) ||
      ts.isVoidExpression(parent) ||
      ts.isDeleteExpression(parent) ||
      ts.isTemplateExpression(parent)
    ) {
      return 'scalarized';
    }
    return 'unknown';
  }
  return 'reaches';
}
