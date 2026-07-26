import ts from 'typescript';

import {
  bindingNames,
  memberAccess,
  propertyNameText,
  unwrapExpression,
} from './feature-export-analysis.mjs';
import {
  immediateIifeInvocation,
  staticNullishness,
  staticTruthiness,
} from './feature-executed-iife-analysis.mjs';

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
      ts.isIterationStatement(current, false)
    ) {
      return current;
    }
    current = current.parent;
  }
  return functionOwner?.body ?? boundary;
}

function constrainPath(path, control, selected, staticSelection = null) {
  if (staticSelection !== null) {
    if (staticSelection !== selected) path.reachable = false;
    return;
  }
  const previous = path.constraints.get(control);
  if (previous !== undefined && previous !== selected) {
    path.reachable = false;
  } else {
    path.constraints.set(control, selected);
  }
}

function executionOwner(node, boundary) {
  for (let current = node.parent; current && current !== boundary; current = current.parent) {
    if (ts.isFunctionLike(current) && !immediateIifeInvocation(current)) return current;
  }
  return boundary;
}

function executionPath(node, boundary) {
  const path = { constraints: new Map(), reachable: true };
  let current = node;
  while (path.reachable && current.parent && current.parent !== boundary) {
    const parent = current.parent;
    if (ts.isIfStatement(parent)) {
      if (containsReference(parent.thenStatement, current)) {
        constrainPath(path, parent, true, staticTruthiness(parent.expression));
      } else if (parent.elseStatement && containsReference(parent.elseStatement, current)) {
        constrainPath(path, parent, false, staticTruthiness(parent.expression));
      }
    } else if (ts.isConditionalExpression(parent)) {
      if (containsReference(parent.whenTrue, current)) {
        constrainPath(path, parent, true, staticTruthiness(parent.condition));
      } else if (containsReference(parent.whenFalse, current)) {
        constrainPath(path, parent, false, staticTruthiness(parent.condition));
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
      let executes = null;
      if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        executes = staticTruthiness(parent.left);
      } else if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        const truthiness = staticTruthiness(parent.left);
        executes = truthiness === null ? null : !truthiness;
      } else {
        executes = staticNullishness(parent.left);
      }
      constrainPath(path, parent, true, executes);
    } else if (
      ts.isIterationStatement(parent, false) &&
      containsReference(parent.statement, current)
    ) {
      const execution = ts.isDoStatement(parent)
        ? true
        : ts.isForStatement(parent)
          ? parent.condition
            ? staticTruthiness(parent.condition)
            : true
          : ts.isWhileStatement(parent)
            ? staticTruthiness(parent.expression)
            : null;
      constrainPath(path, parent, true, execution);
    } else if (ts.isCaseClause(parent) || ts.isDefaultClause(parent) || ts.isCatchClause(parent)) {
      constrainPath(path, parent, true);
    }
    current = parent;
  }
  return path;
}

function constraintsMatch(left, right) {
  return [...left].every(
    ([control, selected]) => !right.has(control) || right.get(control) === selected
  );
}

function withBindingFallback(bindings, target, initializer) {
  if (!initializer) return bindings;
  const relative = new Map(
    selectedBindings(target).map((binding) => [binding.identifier.text, binding.path])
  );
  return bindings.map((binding) => ({
    ...binding,
    fallback: { expression: initializer, selected: relative.get(binding.identifier.text) ?? [] },
  }));
}

function selectedBindings(pattern, path = []) {
  const current = unwrapExpression(pattern);
  if (ts.isIdentifier(current)) return [{ identifier: current, path }];
  if (!ts.isObjectBindingPattern(current) && !ts.isObjectLiteralExpression(current)) return [];
  const elements = ts.isObjectLiteralExpression(current) ? current.properties : current.elements;
  return elements.flatMap((element) => {
    const rest = element.dotDotDotToken || ts.isSpreadAssignment(element);
    const target = ts.isPropertyAssignment(element)
      ? element.initializer
      : (element.name ?? element.expression);
    if (!target) return [];
    const selected = rest ? null : propertyNameText(element.propertyName ?? element.name);
    const bindings = selectedBindings(target, rest ? path : [...path, selected]);
    const initializer =
      (ts.isBindingElement(element) && element.initializer) ||
      (ts.isShorthandPropertyAssignment(element) && element.objectAssignmentInitializer);
    return withBindingFallback(bindings, target, initializer);
  });
}

function reachingWrites(writes, useNode, boundary) {
  const usePath = executionPath(useNode, boundary);
  if (!usePath.reachable) return [];
  const candidates = writes
    .filter(
      (write) =>
        write.position <= useNode.getStart() &&
        executionOwner(write.node, boundary) === executionOwner(useNode, boundary)
    )
    .map((write) => ({ ...write, path: executionPath(write.node, boundary) }))
    .filter(
      (write) =>
        write.path.reachable && constraintsMatch(write.path.constraints, usePath.constraints)
    );
  const controls = new Set();
  for (const write of candidates) {
    for (const control of write.path.constraints.keys()) {
      if (!usePath.constraints.has(control)) controls.add(control);
    }
  }
  if (controls.size > 8) return candidates;

  const variableControls = [...controls];
  const latestWrites = new Map();
  for (let mask = 0; mask < 2 ** variableControls.length; mask += 1) {
    const choices = new Map(usePath.constraints);
    for (const [index, control] of variableControls.entries()) {
      choices.set(control, Boolean(mask & (1 << index)));
    }
    const latest = candidates
      .filter((write) => constraintsMatch(write.path.constraints, choices))
      .sort((left, right) => right.position - left.position)[0];
    if (latest) latestWrites.set(`${latest.position}:${latest.expression.pos}`, latest);
  }
  return [...latestWrites.values()];
}

function collectLocalBindingModel(boundary) {
  const cached = localBindingModels.get(boundary);
  if (cached) return cached;

  const declarationsByName = new Map();
  const addDeclaration = (name, node, scope, initializer, selected = [], fallback) => {
    const declaration = {
      key: `${name}:${node.pos}`,
      position: node.getStart(),
      scope,
      writes: initializer
        ? [{ expression: initializer, fallback, node, selected, position: node.getStart() }]
        : [],
    };
    const declarations = declarationsByName.get(name) ?? [];
    declarationsByName.set(name, [...declarations, declaration]);
  };
  const visitDeclarations = (node) => {
    if (
      ts.isVariableDeclaration(node) ||
      (ts.isParameter(node) && ts.isFunctionLike(node.parent))
    ) {
      const owner = containingFunction(node, boundary);
      const list =
        ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)
          ? node.parent
          : null;
      const scope =
        list && list.flags & ts.NodeFlags.BlockScoped
          ? nearestLexicalScope(node, boundary, owner)
          : (owner?.body ?? boundary);
      for (const binding of selectedBindings(node.name)) {
        addDeclaration(
          binding.identifier.text,
          node,
          scope,
          node.initializer,
          binding.path,
          binding.fallback
        );
      }
    }
    ts.forEachChild(node, visitDeclarations);
  };
  visitDeclarations(boundary);

  const declarationAt = (name, position) =>
    (declarationsByName.get(name) ?? [])
      .filter(
        (declaration) =>
          declaration.position <= position &&
          declaration.scope.pos <= position &&
          position <= declaration.scope.end
      )
      .sort(
        (left, right) =>
          left.scope.end - left.scope.pos - (right.scope.end - right.scope.pos) ||
          right.position - left.position
      )[0] ?? null;

  const visitAssignments = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = unwrapExpression(node.left);
      for (const binding of selectedBindings(target)) {
        const declaration = declarationAt(binding.identifier.text, node.getStart());
        if (declaration) {
          declaration.writes.push({
            expression: node.right,
            node,
            selected: binding.path,
            fallback: binding.fallback,
            position: node.end,
          });
        }
      }
    }
    ts.forEachChild(node, visitAssignments);
  };
  visitAssignments(boundary);

  const model = {
    resolveAll(name, useNode) {
      const declaration = declarationAt(name, useNode.getStart());
      if (!declaration) return [];
      return reachingWrites(declaration.writes, useNode, boundary).map((write) => ({
        ...write,
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
  selected = [],
  visited = new Set(),
  memo = new Map()
) {
  const current = expression && unwrapExpression(expression);
  if (!current) return [];
  const memoKey = `${current.pos}:${current.end}:${selected.join('.')}`;
  if (memo.has(memoKey)) return memo.get(memoKey);
  memo.set(memoKey, []);

  const bindings = collectLocalBindingModel(boundary);
  let resolved = [];
  if (ts.isObjectLiteralExpression(current) && selected.length > 0) {
    const property = current.properties.find(
      (candidate) =>
        (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
        propertyNameText(candidate.name) === selected[0]
    );
    const value =
      property && (ts.isPropertyAssignment(property) ? property.initializer : property.name);
    resolved = value ? resolvedLocalObjects(value, boundary, selected.slice(1), visited, memo) : [];
  } else if (ts.isArrayLiteralExpression(current) && selected.length > 0) {
    const value = current.elements[Number(selected[0])];
    resolved =
      value && !ts.isOmittedExpression(value)
        ? resolvedLocalObjects(value, boundary, selected.slice(1), visited, memo)
        : [];
  } else if (ts.isObjectLiteralExpression(current)) {
    resolved = [current];
  } else if (ts.isConditionalExpression(current)) {
    resolved = [
      ...resolvedLocalObjects(current.whenTrue, boundary, selected, new Set(visited), memo),
      ...resolvedLocalObjects(current.whenFalse, boundary, selected, new Set(visited), memo),
    ];
  } else if (ts.isIdentifier(current)) {
    for (const binding of bindings.resolveAll(current.text, current)) {
      if (visited.has(binding.key)) continue;
      const nextVisited = new Set(visited).add(binding.key);
      const values = resolvedLocalObjects(
        binding.expression,
        boundary,
        [...binding.selected, ...selected],
        nextVisited,
        memo
      );
      resolved.push(...values);
      if (values.length === 0 && binding.fallback) {
        resolved.push(
          ...resolvedLocalObjects(
            binding.fallback.expression,
            boundary,
            [...binding.fallback.selected, ...selected],
            nextVisited,
            memo
          )
        );
      }
    }
  } else {
    const access = memberAccess(current);
    if (access) {
      resolved = resolvedLocalObjects(
        access.receiver,
        boundary,
        [access.name, ...selected],
        visited,
        memo
      );
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

function objectValueMember(expression, reference, boundary) {
  for (const object of resolvedLocalObjects(expression, boundary)) {
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

function descriptorContainsReference(expression, reference, boundary) {
  return resolvedLocalObjects(expression, boundary).some((descriptor) =>
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

function callTargetsBoundaryInstance(call, boundary) {
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
    !callTargetsBoundaryInstance(call, boundary)
  ) {
    return null;
  }
  if (method.name === 'assign') {
    for (const source of call.arguments.slice(1)) {
      const localMember = objectValueMember(source, reference, boundary);
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
