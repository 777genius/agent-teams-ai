import ts from 'typescript';

import {
  bindingNames,
  memberAccess,
  propertyNameText,
  unwrapExpression,
} from './feature-export-analysis.mjs';
import {
  resolvedLocalObjects,
  resolvedLocalValueContainsReference,
  resolvedLocalValueNodes,
  resolvedStaticPropertyNames,
} from './feature-constructor-local-value-analysis.mjs';
import { immediateIifeInvocation } from './feature-executed-iife-analysis.mjs';

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

function functionReturnsResolvedReference(functionNode, reference, boundary) {
  if (!functionNode.body) return false;
  if (ts.isArrowFunction(functionNode) && !ts.isBlock(functionNode.body)) {
    return resolvedLocalValueContainsReference(functionNode.body, reference, boundary, {
      captureOuter: true,
    });
  }
  let returned = false;
  const visit = (node) => {
    if (returned || (node !== functionNode && ts.isFunctionLike(node))) return;
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      resolvedLocalValueContainsReference(node.expression, reference, boundary, {
        captureOuter: true,
      })
    ) {
      returned = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(functionNode.body);
  return returned;
}

function assignedPropertyContainsReference(property, reference, boundary) {
  if (ts.isShorthandPropertyAssignment(property)) {
    return resolvedLocalValueContainsReference(property.name, reference, boundary);
  }
  if (ts.isPropertyAssignment(property)) {
    return resolvedLocalValueContainsReference(property.initializer, reference, boundary);
  }
  return ts.isGetAccessorDeclaration(property)
    ? functionReturnsResolvedReference(property, reference, boundary)
    : false;
}

function assignedPropertyNames(property, boundary) {
  if (!property.name) return [];
  if (ts.isComputedPropertyName(property.name)) {
    return resolvedStaticPropertyNames(property.name.expression, boundary);
  }
  const name = propertyNameText(property.name);
  return name === null ? [] : [name];
}

function overlayObjectState(base, incoming) {
  const result = new Map(base);
  for (const [name, contains] of incoming) result.set(name, contains);
  return result;
}

function objectReferenceStates(object, reference, boundary, visited = new Set()) {
  const key = `${object.pos}:${object.end}`;
  if (visited.has(key)) return [];
  const nextVisited = new Set(visited).add(key);
  let states = [new Map()];
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spreadStates = resolvedLocalObjects(property.expression, boundary).flatMap((spread) =>
        objectReferenceStates(spread, reference, boundary, nextVisited)
      );
      if (spreadStates.length > 0) {
        states = states.flatMap((state) =>
          spreadStates.map((spreadState) => overlayObjectState(state, spreadState))
        );
      }
      continue;
    }
    const contains = assignedPropertyContainsReference(property, reference, boundary);
    const names = assignedPropertyNames(property, boundary);
    if (names.length === 0 && contains && property.name) {
      for (const state of states) state.set('*', true);
      continue;
    }
    for (const state of states) {
      for (const name of names) state.set(name, contains);
    }
  }
  for (const state of states) {
    for (const excluded of object.restExclusions ?? []) state.delete(excluded);
  }
  return states;
}

function objectAssignReferenceMember(expressions, reference, boundary) {
  let states = [new Map()];
  for (const expression of expressions) {
    const sourceStates = resolvedLocalObjects(expression, boundary).flatMap((object) =>
      objectReferenceStates(object, reference, boundary)
    );
    if (sourceStates.length === 0) continue;
    states = states.flatMap((state) =>
      sourceStates.map((sourceState) => overlayObjectState(state, sourceState))
    );
  }
  const names = new Set();
  for (const state of states) {
    for (const [name, contains] of state) {
      if (contains) names.add(name);
    }
  }
  for (const name of names) {
    const publicName = publicInstanceMemberName(boundary, name);
    if (publicName !== null) return publicName;
  }
  return null;
}

function descriptorGetterContainsReference(property, reference, boundary) {
  if (ts.isMethodDeclaration(property)) {
    return functionReturnsResolvedReference(property, reference, boundary);
  }
  if (!ts.isPropertyAssignment(property)) return false;
  return resolvedLocalValueNodes(property.initializer, boundary).some((node) => {
    const getter = unwrapExpression(node);
    return ts.isFunctionLike(getter)
      ? functionReturnsResolvedReference(getter, reference, boundary)
      : resolvedLocalValueContainsReference(getter, reference, boundary);
  });
}

function descriptorContainsReference(expression, reference, boundary) {
  return resolvedLocalObjects(expression, boundary).some((descriptor) =>
    descriptor.properties.some((property) => {
      const name = property.name && propertyNameText(property.name);
      const value =
        ts.isPropertyAssignment(property) && name === 'value'
          ? property.initializer
          : ts.isShorthandPropertyAssignment(property) && name === 'value'
            ? property.name
            : null;
      if (value && resolvedLocalValueContainsReference(value, reference, boundary)) return true;
      return name === 'get' && descriptorGetterContainsReference(property, reference, boundary);
    })
  );
}

function executesOnBoundaryInstance(call, boundary) {
  let owner = null;
  for (let current = call.parent; current && current !== boundary; current = current.parent) {
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      !immediateIifeInvocation(current)
    ) {
      return false;
    }
    if (!owner && ts.isFunctionLike(current) && !ts.isArrowFunction(current)) owner = current;
  }
  owner ??= ts.isFunctionLike(boundary) ? boundary : null;
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

function importBindingNames(statement) {
  if (ts.isImportEqualsDeclaration(statement)) return [statement.name.text];
  const clause =
    ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly
      ? statement.importClause
      : null;
  if (!clause) return [];
  const names = clause.name ? [clause.name.text] : [];
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
  if (bindings && ts.isNamedImports(bindings)) {
    names.push(
      ...bindings.elements.filter((item) => !item.isTypeOnly).map((item) => item.name.text)
    );
  }
  return names;
}

function statementRuntimeBindingNames(statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name)
    );
  }
  const imports = importBindingNames(statement);
  if (imports.length > 0) return imports;
  const runtimeDeclaration =
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement);
  return runtimeDeclaration && statement.name && ts.isIdentifier(statement.name)
    ? [statement.name.text]
    : [];
}

function blockDeclaresRuntimeValue(block, name) {
  const statements = ts.isCaseBlock(block)
    ? block.clauses.flatMap((clause) => clause.statements)
    : block.statements;
  return statements.some((statement) => statementRuntimeBindingNames(statement).includes(name));
}

function functionDeclaresRuntimeValue(functionLike, name) {
  if (
    ((ts.isFunctionDeclaration(functionLike) || ts.isFunctionExpression(functionLike)) &&
      functionLike.name &&
      ts.isIdentifier(functionLike.name) &&
      functionLike.name.text === name) ||
    functionLike.parameters.some((parameter) => bindingNames(parameter.name).includes(name))
  ) {
    return true;
  }
  let found = false;
  const visit = (node) => {
    if (found || (node !== functionLike && ts.isFunctionLike(node))) return;
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.BlockScoped) === 0 &&
      node.declarations.some((declaration) => bindingNames(declaration.name).includes(name))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (functionLike.body) visit(functionLike.body);
  return found;
}

function isLexicallyShadowedRuntimeValue(reference) {
  const name = reference.text;
  const sourceFile = reference.getSourceFile();
  let current = reference.parent;
  while (current && current !== sourceFile) {
    if (
      (ts.isBlock(current) || ts.isCaseBlock(current)) &&
      blockDeclaresRuntimeValue(current, name)
    ) {
      return true;
    }
    if (
      ts.isCatchClause(current) &&
      current.variableDeclaration &&
      bindingNames(current.variableDeclaration.name).includes(name)
    ) {
      return true;
    }
    if (ts.isFunctionLike(current) && functionDeclaresRuntimeValue(current, name)) {
      return true;
    }
    if (ts.isClassExpression(current) && current.name?.text === name) {
      return true;
    }
    const initializer =
      (ts.isForStatement(current) || ts.isForInOrOfStatement(current)) && current.initializer;
    if (
      initializer &&
      ts.isVariableDeclarationList(initializer) &&
      initializer.declarations.some((declaration) => bindingNames(declaration.name).includes(name))
    ) {
      return true;
    }
    current = current.parent;
  }
  return blockDeclaresRuntimeValue(sourceFile, name);
}

function isGlobalMutatorReceiver(receiver) {
  return (
    ts.isIdentifier(receiver) &&
    ['Object', 'Reflect'].includes(receiver.text) &&
    !isLexicallyShadowedRuntimeValue(receiver)
  );
}

function publicInstanceMutatorMember(call, reference, boundary) {
  const method = memberAccess(call.expression);
  if (
    !method ||
    !isGlobalMutatorReceiver(method.receiver) ||
    call.arguments[0]?.kind !== ts.SyntaxKind.ThisKeyword ||
    !executesOnBoundaryInstance(call, boundary)
  ) {
    return null;
  }
  if (method.name === 'assign') {
    return objectAssignReferenceMember(call.arguments.slice(1), reference, boundary);
  } else if (
    method.name === 'set' &&
    call.arguments[2] &&
    resolvedLocalValueContainsReference(call.arguments[2], reference, boundary)
  ) {
    const name = unwrapExpression(call.arguments[1]);
    return publicInstanceMemberName(
      boundary,
      name && (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) ? name.text : '*'
    );
  } else if (
    method.name === 'defineProperty' &&
    descriptorContainsReference(call.arguments[2], reference, boundary)
  ) {
    const name = unwrapExpression(call.arguments[1]);
    return publicInstanceMemberName(
      boundary,
      name && (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) ? name.text : '*'
    );
  } else if (method.name === 'defineProperties') {
    for (const descriptors of resolvedLocalObjects(call.arguments[1], boundary)) {
      for (const property of descriptors.properties) {
        if (
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          descriptorContainsReference(
            ts.isPropertyAssignment(property) ? property.initializer : property.name,
            reference,
            boundary
          )
        ) {
          return publicInstanceMemberName(boundary, propertyNameText(property.name));
        }
      }
    }
  }
  return null;
}

function publicInstanceWriteSelection(reference, boundary) {
  let selection = null;
  const visit = (node) => {
    if (selection || (node !== boundary && ts.isClassLike(node))) return;
    if (
      ts.isBinaryExpression(node) &&
      ts.isAssignmentOperator(node.operatorToken.kind) &&
      executesOnBoundaryInstance(node, boundary) &&
      resolvedLocalValueContainsReference(node.right, reference, boundary)
    ) {
      const localMember = isPublicInstanceAssignment(node.left, boundary);
      if (localMember !== null) {
        selection = { getterOnly: false, localMember };
        return;
      }
    }
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
  const writeSelection = publicInstanceWriteSelection(reference, boundary);
  if (writeSelection) return writeSelection;

  let current = reference;
  let returned = false;
  while (current.parent && current.parent !== boundary) {
    const parent = current.parent;
    if (ts.isReturnStatement(parent)) returned = true;
    if (ts.isYieldExpression(parent)) returned = true;
    if (
      ts.isBinaryExpression(parent) &&
      ts.isAssignmentOperator(parent.operatorToken.kind) &&
      parent.right === current &&
      executesOnBoundaryInstance(parent, boundary)
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
