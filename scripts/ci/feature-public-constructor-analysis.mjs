import ts from 'typescript';

import { memberAccess, propertyNameText, unwrapExpression } from './feature-export-analysis.mjs';
import { resolveObjectLiterals } from './feature-object-resolution.mjs';

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
    } else if (member.name && !isStaticMember(member) && propertyNameText(member.name) === name) {
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
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
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

const localBindingModels = new WeakMap();

function containingFunction(node, boundary) {
  let current = node.parent;
  while (current && current !== boundary) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return ts.isFunctionLike(boundary) ? boundary : null;
}

function nearestLexicalScope(node, boundary, functionOwner) {
  let current = node.parent;
  while (current && current !== boundary) {
    if (
      ts.isBlock(current) ||
      ts.isCaseBlock(current) ||
      ts.isCatchClause(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return functionOwner?.body ?? boundary;
}

function nodeDepth(node) {
  let depth = 0;
  let current = node;
  while (current.parent) {
    depth += 1;
    current = current.parent;
  }
  return depth;
}

function containsPosition(node, position) {
  return node.pos <= position && position <= node.end;
}

function collectLocalBindingModel(boundary) {
  const cached = localBindingModels.get(boundary);
  if (cached) return cached;

  const declarationsByName = new Map();
  const writesByDeclaration = new Map();
  let sequence = 0;
  const addDeclaration = (name, node, scope, initializer) => {
    const declaration = {
      key: `${name}:${node.pos}:${sequence++}`,
      name,
      node,
      position: node.getStart(),
      scope,
      scopeDepth: nodeDepth(scope),
    };
    const declarations = declarationsByName.get(name) ?? [];
    declarations.push(declaration);
    declarationsByName.set(name, declarations);
    writesByDeclaration.set(
      declaration,
      initializer ? [{ expression: initializer, position: node.getStart() }] : []
    );
  };
  const visitDeclarations = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const functionOwner = containingFunction(node, boundary);
      const declarationList = ts.isVariableDeclarationList(node.parent) ? node.parent : null;
      const blockScoped = Boolean(
        declarationList && declarationList.flags & ts.NodeFlags.BlockScoped
      );
      addDeclaration(
        node.name.text,
        node,
        blockScoped
          ? nearestLexicalScope(node, boundary, functionOwner)
          : (functionOwner?.body ?? boundary),
        node.initializer
      );
    } else if (
      ts.isParameter(node) &&
      ts.isIdentifier(node.name) &&
      ts.isFunctionLike(node.parent)
    ) {
      addDeclaration(node.name.text, node, node.parent.body ?? node.parent, node.initializer);
    }
    ts.forEachChild(node, visitDeclarations);
  };
  visitDeclarations(boundary);

  const declarationAt = (name, position) =>
    (declarationsByName.get(name) ?? [])
      .filter(
        (declaration) =>
          declaration.position <= position && containsPosition(declaration.scope, position)
      )
      .sort(
        (left, right) => right.scopeDepth - left.scopeDepth || right.position - left.position
      )[0] ?? null;

  const visitAssignments = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = unwrapExpression(node.left);
      if (ts.isIdentifier(target)) {
        const declaration = declarationAt(target.text, node.getStart());
        if (declaration) {
          writesByDeclaration.get(declaration).push({
            expression: node.right,
            position: node.end,
          });
        }
      }
    }
    ts.forEachChild(node, visitAssignments);
  };
  visitAssignments(boundary);

  const model = {
    resolve(name, position) {
      const declaration = declarationAt(name, position);
      if (!declaration) return null;
      const write = [...writesByDeclaration.get(declaration)]
        .filter((candidate) => candidate.position <= position)
        .sort((left, right) => right.position - left.position)[0];
      return write
        ? {
            beforePosition: write.position,
            expression: write.expression,
            key: `${declaration.key}:${write.position}`,
          }
        : null;
    },
  };
  localBindingModels.set(boundary, model);
  return model;
}

function resolvedLocalObjects(expression, boundary, beforePosition) {
  const bindings = collectLocalBindingModel(boundary);
  return resolveObjectLiterals(expression, beforePosition, (name, position) =>
    bindings.resolve(name, position)
  );
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

function objectValueMember(expression, reference, boundary, beforePosition) {
  for (const object of resolvedLocalObjects(expression, boundary, beforePosition)) {
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
  }
  return null;
}

function functionReturnsReference(functionNode, reference) {
  if (!functionNode.body || !containsReference(functionNode.body, reference)) return false;
  if (ts.isArrowFunction(functionNode) && !ts.isBlock(functionNode.body)) {
    let current = reference;
    while (current && current !== functionNode.body) {
      if (ts.isFunctionLike(current)) return false;
      current = current.parent;
    }
    return current === functionNode.body;
  }
  let current = reference;
  while (current && current !== functionNode) {
    if (ts.isFunctionLike(current)) return false;
    if (ts.isReturnStatement(current)) return true;
    current = current.parent;
  }
  return false;
}

function descriptorGetterContainsReference(property, reference) {
  if (ts.isMethodDeclaration(property)) {
    return functionReturnsReference(property, reference);
  }
  if (!ts.isPropertyAssignment(property)) return false;
  const getter = unwrapExpression(property.initializer);
  return ts.isFunctionLike(getter)
    ? functionReturnsReference(getter, reference)
    : valueExpressionContainsReference(getter, reference);
}

function descriptorContainsReference(expression, reference, boundary, beforePosition) {
  return resolvedLocalObjects(expression, boundary, beforePosition).some((descriptor) =>
    descriptor.properties.some((property) => {
      const name = property.name && propertyNameText(property.name);
      if (
        name === 'value' &&
        ts.isPropertyAssignment(property) &&
        valueExpressionContainsReference(property.initializer, reference)
      ) {
        return true;
      }
      return name === 'get' && descriptorGetterContainsReference(property, reference);
    })
  );
}

function isDirectlyInvokedFunction(functionNode) {
  let expression = functionNode;
  while (
    expression.parent &&
    !ts.isCallExpression(expression.parent) &&
    unwrapExpression(expression.parent) === functionNode
  ) {
    expression = expression.parent;
  }
  return (
    ts.isCallExpression(expression.parent) &&
    unwrapExpression(expression.parent.expression) === functionNode
  );
}

function hasDeferredFunctionBoundary(node, boundary) {
  let current = node.parent;
  while (current && current !== boundary) {
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      !isDirectlyInvokedFunction(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function boundaryThisOwner(node, boundary) {
  let current = node.parent;
  while (current && current !== boundary) {
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current)) return current;
    current = current.parent;
  }
  return ts.isFunctionLike(boundary) ? boundary : null;
}

function callTargetsBoundaryInstance(call, boundary) {
  if (hasDeferredFunctionBoundary(call, boundary)) return false;
  const owner = boundaryThisOwner(call, boundary);
  if (ts.isClassLike(boundary)) {
    if (owner) return owner.parent === boundary && !isStaticMember(owner);
    let member = call;
    while (member.parent && member.parent !== boundary) member = member.parent;
    return (
      member.parent === boundary && ts.isPropertyDeclaration(member) && !isStaticMember(member)
    );
  }
  return owner === boundary;
}

function publicInstanceMutatorMember(call, reference, boundary) {
  const method = memberAccess(call.expression);
  if (
    !method ||
    !ts.isIdentifier(method.receiver) ||
    !['Object', 'Reflect'].includes(method.receiver.text) ||
    call.arguments[0]?.kind !== ts.SyntaxKind.ThisKeyword ||
    !callTargetsBoundaryInstance(call, boundary)
  ) {
    return null;
  }
  const beforePosition = call.getStart();
  if (method.name === 'assign') {
    for (const source of call.arguments.slice(1)) {
      const localMember = objectValueMember(source, reference, boundary, beforePosition);
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
      name && (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) ? name.text : '*'
    );
  } else if (
    method.name === 'defineProperty' &&
    descriptorContainsReference(call.arguments[2], reference, boundary, beforePosition)
  ) {
    const name = unwrapExpression(call.arguments[1]);
    return publicInstanceMemberName(
      boundary,
      name && (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) ? name.text : '*'
    );
  } else if (method.name === 'defineProperties') {
    for (const descriptors of resolvedLocalObjects(call.arguments[1], boundary, beforePosition)) {
      for (const property of descriptors.properties) {
        if (
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          descriptorContainsReference(
            ts.isPropertyAssignment(property) ? property.initializer : property.name,
            reference,
            boundary,
            beforePosition
          )
        ) {
          return publicInstanceMemberName(boundary, propertyNameText(property.name));
        }
      }
    }
  }
  return null;
}

function publicInstanceMutatorSelection(reference, boundary) {
  let selection = null;
  const visit = (node) => {
    if (selection || (node !== boundary && ts.isClassLike(node))) return;
    if (ts.isCallExpression(node)) {
      const localMember = publicInstanceMutatorMember(node, reference, boundary);
      if (localMember !== null) {
        selection = { getterOnly: false, localMember };
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(boundary);
  return selection;
}

export function publicConstructorSelection(reference, boundary) {
  const mutatorSelection = publicInstanceMutatorSelection(reference, boundary);
  if (mutatorSelection) return mutatorSelection;

  let current = reference;
  let returned = false;
  while (current.parent && current.parent !== boundary) {
    const parent = current.parent;
    if (ts.isReturnStatement(parent)) returned = true;
    if (ts.isYieldExpression(parent)) returned = true;
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
      ts.isParameter(parent) &&
      ts.isConstructorDeclaration(parent.parent) &&
      parent.parent.parent === boundary &&
      ts.isParameterPropertyDeclaration(parent, parent.parent) &&
      isPublicInstanceMember(parent)
    ) {
      return { getterOnly: false, localMember: propertyNameText(parent.name) };
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
