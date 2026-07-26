import ts from 'typescript';

import {
  memberAccess,
  propertyNameText,
  unwrapExpression,
} from './feature-export-analysis.mjs';

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

function isStaticMember(node) {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some(({ kind }) => kind === ts.SyntaxKind.StaticKeyword) ?? false;
}

function declaredInstanceMember(boundary, name) {
  for (const member of boundary.members) {
    if (ts.isConstructorDeclaration(member)) {
      const parameter = member.parameters.find(
        (candidate) =>
          ts.isParameterPropertyDeclaration(candidate, member) &&
          propertyNameText(candidate.name) === name
      );
      if (parameter) return parameter;
    } else if (
      member.name &&
      !isStaticMember(member) &&
      propertyNameText(member.name) === name
    ) {
      return member;
    }
  }
  return null;
}

function statementContainer(node) {
  let current = node.parent;
  while (current && !Array.isArray(current.statements)) current = current.parent;
  return current;
}

function localClassBinding(boundary, name) {
  const container = statementContainer(boundary);
  if (!container) return null;
  for (const statement of container.statements) {
    if (
      ts.isClassDeclaration(statement) &&
      statement.name?.text === name
    ) {
      return statement;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer && unwrapExpression(declaration.initializer);
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        initializer &&
        ts.isClassExpression(initializer)
      ) {
        return initializer;
      }
    }
  }
  return null;
}

function publicInstanceMemberName(boundary, name, visited = new Set()) {
  if (!ts.isClassLike(boundary) || name === '*') return name;
  const declared = declaredInstanceMember(boundary, name);
  if (declared) return isPublicInstanceMember(declared) ? name : null;
  const heritage = boundary.heritageClauses?.find(
    ({ token }) => token === ts.SyntaxKind.ExtendsKeyword
  );
  if (!heritage?.types[0]) return name;
  const baseExpression = unwrapExpression(heritage.types[0].expression);
  if (!ts.isIdentifier(baseExpression)) return null;
  const base = localClassBinding(boundary, baseExpression.text);
  if (!base || visited.has(base)) return null;
  return publicInstanceMemberName(base, name, new Set(visited).add(base));
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
  return publicInstanceMemberName(boundary, target.name);
}

function containsReference(node, reference) {
  return reference.pos >= node.pos && reference.end <= node.end;
}

function valueExpressionContainsReference(expression, reference) {
  const value = unwrapExpression(expression);
  if (ts.isFunctionLike(value) || !containsReference(value, reference)) return false;
  let current = reference;
  while (current && current !== value) {
    if (ts.isFunctionLike(current)) return false;
    current = current.parent;
  }
  return current === value;
}

function objectValueMember(expression, reference) {
  const object = expression && unwrapExpression(expression);
  if (!object || !ts.isObjectLiteralExpression(object)) return null;
  for (const property of object.properties) {
    if (ts.isShorthandPropertyAssignment(property) && containsReference(property, reference)) {
      return propertyNameText(property.name);
    }
    if (
      ts.isPropertyAssignment(property) &&
      valueExpressionContainsReference(property.initializer, reference)
    ) {
      return propertyNameText(property.name);
    }
  }
  return null;
}

function descriptorValueContainsReference(expression, reference) {
  const descriptor = expression && unwrapExpression(expression);
  if (!descriptor || !ts.isObjectLiteralExpression(descriptor)) return false;
  return descriptor.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === 'value' &&
      valueExpressionContainsReference(property.initializer, reference)
  );
}

function publicInstanceMutatorMember(call, reference, boundary) {
  const method = memberAccess(call.expression);
  if (
    !method ||
    !ts.isIdentifier(method.receiver) ||
    !['Object', 'Reflect'].includes(method.receiver.text) ||
    call.arguments[0]?.kind !== ts.SyntaxKind.ThisKeyword
  ) {
    return null;
  }
  if (method.name === 'assign') {
    for (const source of call.arguments.slice(1)) {
      const localMember = objectValueMember(source, reference);
      if (localMember !== null) {
        return publicInstanceMemberName(boundary, localMember);
      }
    }
  } else if (
    method.name === 'set' &&
    call.arguments[2] &&
    valueExpressionContainsReference(call.arguments[2], reference)
  ) {
    const name = unwrapExpression(call.arguments[1]);
    return publicInstanceMemberName(
      boundary,
      name && (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
        ? name.text
        : '*'
    );
  } else if (
    method.name === 'defineProperty' &&
    descriptorValueContainsReference(call.arguments[2], reference)
  ) {
    const name = unwrapExpression(call.arguments[1]);
    return publicInstanceMemberName(
      boundary,
      name && (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
        ? name.text
        : '*'
    );
  } else if (method.name === 'defineProperties') {
    const descriptors = call.arguments[1] && unwrapExpression(call.arguments[1]);
    if (descriptors && ts.isObjectLiteralExpression(descriptors)) {
      const property = descriptors.properties.find(
        (candidate) =>
          ts.isPropertyAssignment(candidate) &&
          descriptorValueContainsReference(candidate.initializer, reference)
      );
      if (property?.name) {
        return publicInstanceMemberName(boundary, propertyNameText(property.name));
      }
    }
  }
  return null;
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
    if (ts.isCallExpression(parent)) {
      const localMember = publicInstanceMutatorMember(parent, reference, boundary);
      if (localMember !== null) {
        return { getterOnly: false, localMember };
      }
    }
    if (
      (ts.isPropertyDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isMethodDeclaration(parent)) &&
      parent.parent === boundary &&
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
