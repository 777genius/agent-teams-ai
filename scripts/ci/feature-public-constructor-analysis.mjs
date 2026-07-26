import ts from 'typescript';

import {
  bindingNames,
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

function staticBooleanValue(expression) {
  const value = unwrapExpression(expression);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = staticBooleanValue(value.operand);
    return operand === null ? null : !operand;
  }
  return null;
}

function conditionalBranchState(condition, selectedWhenTrue) {
  const value = staticBooleanValue(condition);
  if (value === null) return 'conditional';
  return value === selectedWhenTrue ? 'definite' : 'unreachable';
}

function writeExecutionState(node, boundary) {
  let state = 'definite';
  let current = node;
  while (current.parent && current.parent !== boundary) {
    const parent = current.parent;
    let branchState = 'definite';
    if (ts.isIfStatement(parent)) {
      if (containsReference(parent.thenStatement, current)) {
        branchState = conditionalBranchState(parent.expression, true);
      } else if (parent.elseStatement && containsReference(parent.elseStatement, current)) {
        branchState = conditionalBranchState(parent.expression, false);
      }
    } else if (ts.isConditionalExpression(parent)) {
      if (containsReference(parent.whenTrue, current)) {
        branchState = conditionalBranchState(parent.condition, true);
      } else if (containsReference(parent.whenFalse, current)) {
        branchState = conditionalBranchState(parent.condition, false);
      }
    } else if (
      ts.isBinaryExpression(parent) &&
      containsReference(parent.right, current) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(parent.operatorToken.kind)
    ) {
      const left = staticBooleanValue(parent.left);
      if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        branchState = left === true ? 'definite' : left === false ? 'unreachable' : 'conditional';
      } else if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        branchState = left === false ? 'definite' : left === true ? 'unreachable' : 'conditional';
      } else {
        branchState = 'conditional';
      }
    } else if (
      ((ts.isForStatement(parent) ||
        ts.isForInStatement(parent) ||
        ts.isForOfStatement(parent) ||
        ts.isWhileStatement(parent)) &&
        containsReference(parent.statement, current)) ||
      ts.isCaseClause(parent) ||
      ts.isDefaultClause(parent) ||
      ts.isCatchClause(parent)
    ) {
      branchState = 'conditional';
    }
    if (branchState === 'unreachable') return 'unreachable';
    if (branchState === 'conditional') state = 'conditional';
    current = parent;
  }
  return state;
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
      initializer
        ? [
            {
              expression: initializer,
              position: node.getStart(),
              state: writeExecutionState(node, boundary),
            },
          ]
        : []
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
            state: writeExecutionState(node, boundary),
          });
        }
      }
    }
    ts.forEachChild(node, visitAssignments);
  };
  visitAssignments(boundary);

  const model = {
    resolveAll(name, position) {
      const declaration = declarationAt(name, position);
      if (!declaration) return [];
      const writes = writesByDeclaration
        .get(declaration)
        .filter((candidate) => candidate.position <= position && candidate.state !== 'unreachable')
        .sort((left, right) => left.position - right.position);
      const lastDefiniteIndex = writes.findLastIndex((candidate) => candidate.state === 'definite');
      const reachingWrites = writes.filter(
        (candidate, index) =>
          index === lastDefiniteIndex ||
          (index > lastDefiniteIndex && candidate.state === 'conditional')
      );
      return reachingWrites.map((write) => ({
        beforePosition: write.position,
        expression: write.expression,
        key: `${declaration.key}:${write.position}`,
      }));
    },
  };
  localBindingModels.set(boundary, model);
  return model;
}

function uniqueNodes(nodes) {
  return [...new Map(nodes.map((node) => [`${node.pos}:${node.end}`, node])).values()];
}

function resolvedLocalObjects(
  expression,
  boundary,
  beforePosition,
  visited = new Set(),
  memo = new Map()
) {
  const current = expression && unwrapExpression(expression);
  if (!current) return [];
  const memoKey = `${current.pos}:${current.end}:${beforePosition}`;
  if (memo.has(memoKey)) return memo.get(memoKey);
  memo.set(memoKey, []);

  const bindings = collectLocalBindingModel(boundary);
  let resolved = [];
  if (ts.isObjectLiteralExpression(current)) {
    resolved = [current];
  } else if (ts.isConditionalExpression(current)) {
    resolved = [
      ...resolvedLocalObjects(current.whenTrue, boundary, beforePosition, new Set(visited), memo),
      ...resolvedLocalObjects(current.whenFalse, boundary, beforePosition, new Set(visited), memo),
    ];
  } else if (ts.isIdentifier(current)) {
    for (const binding of bindings.resolveAll(current.text, beforePosition)) {
      if (visited.has(binding.key)) continue;
      resolved.push(
        ...resolvedLocalObjects(
          binding.expression,
          boundary,
          binding.beforePosition,
          new Set(visited).add(binding.key),
          memo
        )
      );
    }
  } else {
    const access = memberAccess(current);
    if (access) {
      resolved = resolvedLocalObjects(
        access.receiver,
        boundary,
        beforePosition,
        visited,
        memo
      ).flatMap((object) => {
        const property = object.properties.find(
          (candidate) =>
            (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
            propertyNameText(candidate.name) === access.name
        );
        if (property && ts.isPropertyAssignment(property)) {
          return resolvedLocalObjects(
            property.initializer,
            boundary,
            beforePosition,
            visited,
            memo
          );
        }
        return property && ts.isShorthandPropertyAssignment(property)
          ? resolvedLocalObjects(property.name, boundary, beforePosition, visited, memo)
          : [];
      });
    }
  }
  const unique = uniqueNodes(resolved);
  memo.set(memoKey, unique);
  return unique;
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

function importBindingNames(statement) {
  if (ts.isImportEqualsDeclaration(statement)) return [statement.name.text];
  if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) {
    return [];
  }
  const clause = statement.importClause;
  if (!clause) return [];
  const names = clause.name ? [clause.name.text] : [];
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    names.push(clause.namedBindings.name.text);
  } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    names.push(
      ...clause.namedBindings.elements
        .filter((element) => !element.isTypeOnly)
        .map((element) => element.name.text)
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
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name &&
    ts.isIdentifier(statement.name)
  ) {
    return [statement.name.text];
  }
  return [];
}

function blockDeclaresRuntimeValue(block, name) {
  const statements = ts.isCaseBlock(block)
    ? block.clauses.flatMap((clause) => clause.statements)
    : block.statements;
  return statements.some((statement) => statementRuntimeBindingNames(statement).includes(name));
}

function functionDeclaresRuntimeValue(functionLike, name) {
  if (
    ('name' in functionLike &&
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

function loopInitializerDeclaresRuntimeValue(node, name) {
  const initializer =
    ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
      ? node.initializer
      : null;
  return (
    initializer &&
    ts.isVariableDeclarationList(initializer) &&
    initializer.declarations.some((declaration) => bindingNames(declaration.name).includes(name))
  );
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
    if (loopInitializerDeclaresRuntimeValue(current, name)) return true;
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
