import ts from 'typescript';
import { memberAccess, unwrapExpression } from './feature-export-analysis.mjs';
import {
  resolveLiteralSelection,
  selectedBindings,
  selectionKey,
} from './feature-local-binding-selection.mjs';
import {
  executedIifeForCall,
  immediateIifeInvocation,
  staticNullishness,
  staticTruthiness,
} from './feature-executed-iife-analysis.mjs';
import { staticUndefinedness } from './feature-static-value-analysis.mjs';
import {
  budgetedWriteSequences,
  constraintsMatch,
  createConstructorLocalValueBudget,
} from './feature-constructor-local-value-budget-analysis.mjs';
import { statementMayCompleteNormally } from './feature-definite-execution.mjs';
const localBindingModels = new WeakMap();
const logicalAssignmentKinds = new Set([
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);
function immediateApplyInvocation(node) {
  if (!ts.isArrowFunction(node) && !(ts.isFunctionExpression(node) && !node.asteriskToken)) {
    return null;
  }
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSatisfiesExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
      parent.right === current
    ) {
      current = parent;
      continue;
    }
    break;
  }
  const method = current.parent;
  const methodCall = method?.parent;
  const access = method && !method.questionDotToken && memberAccess(method);
  return access?.receiver === unwrapExpression(current) &&
    access.name === 'apply' &&
    methodCall &&
    ts.isCallExpression(methodCall) &&
    !methodCall.questionDotToken &&
    methodCall.expression === method
    ? methodCall
    : null;
}
export const immediateConstructorIifeInvocation = (node) =>
  immediateIifeInvocation(node) ?? immediateApplyInvocation(node);
const containsReference = (node, ref) => ref.pos >= node.pos && ref.end <= node.end;
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
    if (ts.isFunctionLike(current) && !immediateConstructorIifeInvocation(current)) return current;
  }
  return boundary;
}
const reachableContainerStatements = new WeakMap();
function reachableStatementsIn(container, statements) {
  let reachable = reachableContainerStatements.get(container);
  if (reachable) return reachable;
  reachable = new Set();
  let completes = true;
  for (const statement of statements) {
    if (completes) reachable.add(statement);
    completes &&= statementMayCompleteNormally(statement);
  }
  reachableContainerStatements.set(container, reachable);
  return reachable;
}
function statementPrefixIsReachable(node, boundary) {
  let current = node;
  while (current && current !== boundary) {
    const parent = current.parent;
    if (!parent) break;
    const statements =
      ts.isBlock(parent) || ts.isSourceFile(parent)
        ? parent.statements
        : ts.isCaseClause(parent) || ts.isDefaultClause(parent)
          ? parent.statements
          : null;
    if (statements?.includes(current) && !reachableStatementsIn(parent, statements).has(current)) {
      return false;
    }
    if (parent === boundary) break;
    if (ts.isFunctionLike(parent)) {
      const invocation = immediateConstructorIifeInvocation(parent);
      if (!invocation) break;
      current = invocation;
      continue;
    }
    current = parent;
  }
  return true;
}
export function executionPath(node, boundary) {
  const path = { constraints: new Map(), reachable: statementPrefixIsReachable(node, boundary) };
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
export function pathAwareWriteSequences(
  writes,
  boundary,
  budget = createConstructorLocalValueBudget()
) {
  const candidates = writes
    .map((write) => {
      const path = { constraints: new Map(), reachable: true };
      for (const pathNode of write.pathNodes ?? [write.node]) {
        const nextPath = executionPath(pathNode, boundary);
        path.reachable &&= nextPath.reachable;
        for (const [control, selected] of nextPath.constraints) {
          const previous = path.constraints.get(control);
          if (previous !== undefined && previous !== selected) path.reachable = false;
          else path.constraints.set(control, selected);
        }
      }
      return { ...write, path };
    })
    .filter((write) => write.path.reachable)
    .sort((left, right) => left.position - right.position);
  return budgetedWriteSequences(candidates, new Map(), budget);
}
const uniqueWrites = (writes) => [...new Map(writes.map((item) => [item.key, item])).values()];
function applyLogicalWrite(states, write, classify) {
  const next = [];
  for (const state of states) {
    const executes = classify(state, write.operator);
    if (executes !== true) next.push(state);
    if (executes !== false) next.push(write);
  }
  return uniqueWrites(next);
}
function writeSequenceOutcomes(sequences, classify) {
  const outcomes = [];
  for (const pathWrites of sequences) {
    let states = [];
    for (const write of pathWrites) {
      states = logicalAssignmentKinds.has(write.operator)
        ? applyLogicalWrite(states, write, classify)
        : [write];
    }
    outcomes.push(...states);
  }
  return uniqueWrites(outcomes);
}
function reachingWrites(writes, useNode, boundary, classify, captureOuter, declaration) {
  let useOwner = executionOwner(useNode, boundary);
  let usePath = executionPath(useNode, boundary);
  let usePosition = useNode.getStart();
  if (captureOuter && declaration.owner !== useOwner) {
    useOwner = declaration.owner;
    usePath = {
      ...usePath,
      constraints: new Map(
        [...usePath.constraints].filter(
          ([control]) => executionOwner(control, boundary) === declaration.owner
        )
      ),
    };
    usePosition = declaration.scope.end;
  }
  if (!usePath.reachable) return [];
  const candidates = writes
    .filter(
      (write) => write.position <= usePosition && executionOwner(write.node, boundary) === useOwner
    )
    .map((write) => ({ ...write, path: executionPath(write.node, boundary) }))
    .filter(
      (write) =>
        write.path.reachable && constraintsMatch(write.path.constraints, usePath.constraints)
    );
  return writeSequenceOutcomes(
    budgetedWriteSequences(
      candidates.sort((left, right) => left.position - right.position),
      usePath.constraints
    ),
    classify
  );
}
function collectLocalBindingModel(boundary) {
  const cached = localBindingModels.get(boundary);
  if (cached) return cached;
  const declarationsByName = new Map();
  const addDeclaration = (
    name,
    node,
    scope,
    initializer,
    selected = [],
    fallback,
    position = node.getStart()
  ) => {
    const declarationKey = `${name}:${node.pos}`;
    const seed = {
      fallback,
      key: `${declarationKey}:${node.getStart()}`,
      node,
      operator: ts.SyntaxKind.EqualsToken,
      position,
      selected,
    };
    if (!initializer) seed.seed = ts.isParameter(node) ? 'unknown' : 'undefined';
    else seed.expression = initializer;
    const declaration = {
      key: declarationKey,
      owner: executionOwner(node, boundary),
      position,
      scope,
      writes: [seed],
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
    } else if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const owner = containingFunction(node, boundary);
      const scope = nearestLexicalScope(node, boundary, owner);
      addDeclaration(node.name.text, node, scope, node, [], undefined, scope.pos);
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
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        logicalAssignmentKinds.has(node.operatorToken.kind))
    ) {
      const target = unwrapExpression(node.left);
      for (const binding of selectedBindings(target)) {
        const declaration = declarationAt(binding.identifier.text, node.getStart());
        if (declaration) {
          declaration.writes.push({
            expression: node.right,
            fallback: binding.fallback,
            key: `${declaration.key}:${node.end}`,
            node,
            operator: node.operatorToken.kind,
            position: node.end,
            selected: binding.path,
          });
        }
      }
    }
    ts.forEachChild(node, visitAssignments);
  };
  visitAssignments(boundary);
  const model = {
    resolveAll(name, useNode, classify, captureOuter) {
      const declaration = declarationAt(name, useNode.getStart());
      return declaration
        ? reachingWrites(declaration.writes, useNode, boundary, classify, captureOuter, declaration)
        : [];
    },
  };
  localBindingModels.set(boundary, model);
  return model;
}
function uniqueNodes(nodes) {
  return [...new Map(nodes.map((node) => [`${node.pos}:${node.end}`, node])).values()];
}
function mergeResolution(...resolutions) {
  return {
    missing: resolutions.some(({ missing }) => missing),
    nodes: uniqueNodes(resolutions.flatMap(({ nodes }) => nodes)),
    unknown: resolutions.some(({ unknown }) => unknown),
  };
}
function staticValueTruthiness(expression) {
  const known = staticTruthiness(expression);
  if (known !== null) return known;
  const current = unwrapExpression(expression);
  if (
    ts.isObjectLiteralExpression(current) ||
    ts.isArrayLiteralExpression(current) ||
    ts.isFunctionLike(current) ||
    ts.isClassLike(current) ||
    ts.isNewExpression(current)
  ) {
    return true;
  }
  return staticUndefinedness(current) === true ? false : null;
}
function staticValueNullishness(expression) {
  const current = unwrapExpression(expression);
  if (current.kind === ts.SyntaxKind.NullKeyword || staticUndefinedness(current) === true) {
    return true;
  }
  const truthiness = staticValueTruthiness(current);
  return truthiness === null ? null : false;
}
function assignmentExecutesForNode(node, operator) {
  if (operator === ts.SyntaxKind.QuestionQuestionEqualsToken) {
    return staticValueNullishness(node);
  }
  const truthiness = staticValueTruthiness(node);
  if (truthiness === null) return null;
  return operator === ts.SyntaxKind.BarBarEqualsToken ? !truthiness : truthiness;
}
function applyFallback(primary, fallback, selected, resolve) {
  if (!fallback) return primary;
  let needsFallback = primary.missing || primary.unknown;
  const defined = [];
  for (const node of primary.nodes) {
    const undefinedness = staticUndefinedness(node);
    if (undefinedness !== true) defined.push(node);
    if (undefinedness !== false) needsFallback = true;
  }
  if (!needsFallback) return { missing: false, nodes: uniqueNodes(defined), unknown: false };
  const fallbackResolution = resolve(fallback.expression, [...fallback.selected, ...selected]);
  return {
    missing: fallbackResolution.missing,
    nodes: uniqueNodes([...defined, ...fallbackResolution.nodes]),
    unknown: primary.unknown || fallbackResolution.unknown,
  };
}
function resolvedWrite(write, boundary, visited, memo, selected = [], captureOuter = false) {
  if (write.seed === 'unknown') return { missing: false, nodes: [], unknown: true };
  if (write.seed === 'undefined') return { missing: true, nodes: [], unknown: false };
  const resolve = (expression, selection = []) =>
    resolvedLocalValues(expression, boundary, selection, visited, memo, captureOuter);
  const primary = resolve(write.expression, [...write.selected, ...selected]);
  return applyFallback(primary, write.fallback, selected, resolve);
}
function logicalWriteDecision(state, operator, boundary, visited, memo, captureOuter) {
  const resolution = resolvedWrite(
    state,
    boundary,
    new Set(visited).add(state.key),
    memo,
    [],
    captureOuter
  );
  const outcomes = [];
  if (resolution.missing) {
    outcomes.push(operator !== ts.SyntaxKind.AmpersandAmpersandEqualsToken);
  }
  if (resolution.unknown) outcomes.push(true, false);
  for (const node of resolution.nodes) {
    const executes = assignmentExecutesForNode(node, operator);
    if (executes === null) outcomes.push(true, false);
    else outcomes.push(executes);
  }
  if (outcomes.length === 0) return null;
  return outcomes.every(Boolean) ? true : outcomes.every((value) => !value) ? false : null;
}
function staticPropertyName(node) {
  const current = unwrapExpression(node);
  return ts.isStringLiteralLike(current) || ts.isNumericLiteral(current) ? current.text : null;
}
function selectedAccessNode(expression, selected) {
  if (selected.some((name) => typeof name !== 'string' || name === '*')) return null;
  const access = selected.reduce(
    (receiver, name) =>
      ts.factory.createElementAccessExpression(receiver, ts.factory.createStringLiteral(name)),
    expression
  );
  return ts.setTextRange(access, expression);
}
function directExecutedCallable(call) {
  const invocation = executedIifeForCall(call);
  if (invocation) return invocation;
  const method = memberAccess(call.expression);
  if (method?.name !== 'apply') return null;
  const callable = unwrapExpression(method.receiver);
  if (!ts.isArrowFunction(callable) && !ts.isFunctionExpression(callable)) return null;
  return {
    arguments: [],
    call,
    callable,
  };
}
function resolvedCallableInvocations(call, boundary, visited, memo, captureOuter) {
  const direct = directExecutedCallable(call);
  if (direct) return [direct];
  if (memberAccess(call.expression)) return [];
  return uniqueNodes(
    resolvedLocalValues(call.expression, boundary, [], new Set(visited), memo, captureOuter)
      .nodes.map(unwrapExpression)
      .filter(
        (node) =>
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node) ||
          ts.isFunctionDeclaration(node)
      )
  ).map((callable) => ({ arguments: [...call.arguments], call, callable }));
}
function callableReturnResolution(invocation, boundary, selected, visited, memo, captureOuter) {
  if (!invocation) return null;
  const { callable, call } = invocation;
  if (!callable.body) return null;
  if (ts.isArrowFunction(callable) && !ts.isBlock(callable.body)) {
    return resolvedLocalValues(callable.body, boundary, selected, visited, memo, captureOuter);
  }
  const returns = [];
  const visit = (node) => {
    if (node !== callable.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isReturnStatement(node)) {
      if (executionPath(node, callable.body).reachable) returns.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(callable.body);
  if (returns.length === 0) {
    return { missing: true, nodes: [], unknown: false };
  }
  const resolutions = returns.map((expression) =>
    expression
      ? resolvedLocalValues(expression, boundary, selected, new Set(visited), memo, captureOuter)
      : { missing: true, nodes: [], unknown: false }
  );
  const resolution = mergeResolution(...resolutions);
  return resolution.unknown && resolution.nodes.length === 0
    ? { missing: false, nodes: [call], unknown: true }
    : resolution;
}
function resolvedLocalValues(
  expression,
  boundary,
  selected = [],
  visited = new Set(),
  memo = new Map(),
  captureOuter = false
) {
  const current = expression && unwrapExpression(expression);
  if (!current) return { missing: true, nodes: [], unknown: false };
  const memoKey = `${current.pos}:${current.end}:${selectionKey(selected)}:${captureOuter}`;
  if (memo.has(memoKey)) return memo.get(memoKey);
  memo.set(memoKey, { missing: false, nodes: [], unknown: true });
  const bindings = collectLocalBindingModel(boundary);
  const resolve = (value, remaining = []) =>
    resolvedLocalValues(value, boundary, remaining, visited, memo, captureOuter);
  const resolveKey = (value) =>
    resolvedStaticPropertyNames(value, boundary, visited, memo, captureOuter);
  const literalSelection = resolveLiteralSelection(current, selected, resolve, resolveKey);
  let resolution;
  if (literalSelection !== null) {
    resolution = literalSelection;
  } else if (ts.isConditionalExpression(current)) {
    const truthiness = staticTruthiness(current.condition);
    resolution =
      truthiness === null
        ? mergeResolution(
            resolvedLocalValues(
              current.whenTrue,
              boundary,
              selected,
              new Set(visited),
              memo,
              captureOuter
            ),
            resolvedLocalValues(
              current.whenFalse,
              boundary,
              selected,
              new Set(visited),
              memo,
              captureOuter
            )
          )
        : resolvedLocalValues(
            truthiness ? current.whenTrue : current.whenFalse,
            boundary,
            selected,
            visited,
            memo,
            captureOuter
          );
  } else if (ts.isCallExpression(current)) {
    const callableReturns = resolvedCallableInvocations(
      current,
      boundary,
      visited,
      memo,
      captureOuter
    )
      .map((invocation) =>
        callableReturnResolution(
          invocation,
          boundary,
          selected,
          new Set(visited),
          memo,
          captureOuter
        )
      )
      .filter(Boolean);
    resolution =
      (callableReturns.length > 0 ? mergeResolution(...callableReturns) : null) ??
      (selected.length > 0
        ? { missing: true, nodes: [], unknown: true }
        : { missing: false, nodes: [current], unknown: false });
  } else if (ts.isIdentifier(current)) {
    const writes = bindings.resolveAll(
      current.text,
      current,
      (state, operator) =>
        logicalWriteDecision(state, operator, boundary, visited, memo, captureOuter),
      captureOuter
    );
    const values = [];
    for (const write of writes) {
      if (visited.has(write.key)) continue;
      values.push(
        resolvedWrite(
          write,
          boundary,
          new Set(visited).add(write.key),
          memo,
          selected,
          captureOuter
        )
      );
    }
    resolution =
      values.length > 0
        ? mergeResolution(...values)
        : selected.length > 0
          ? {
              missing: false,
              nodes: [selectedAccessNode(current, selected)].filter(Boolean),
              unknown: false,
            }
          : { missing: false, nodes: [current], unknown: false };
  } else {
    const access = memberAccess(current);
    if (access) {
      const selectedResolution = resolvedLocalValues(
        access.receiver,
        boundary,
        [access.name, ...selected],
        visited,
        memo,
        captureOuter
      );
      resolution =
        selected.length === 0 &&
        selectedResolution.nodes.length === 0 &&
        (selectedResolution.missing || selectedResolution.unknown)
          ? { missing: false, nodes: [current], unknown: false }
          : selectedResolution;
    } else {
      resolution =
        selected.length > 0
          ? { missing: true, nodes: [], unknown: true }
          : { missing: false, nodes: [current], unknown: false };
    }
  }
  const normalized = { ...resolution, nodes: uniqueNodes(resolution.nodes) };
  memo.set(memoKey, normalized);
  return normalized;
}
export function resolvedStaticPropertyNames(
  expression,
  boundary,
  visited = new Set(),
  memo = new Map(),
  captureOuter = false
) {
  return [
    ...new Set(
      resolvedLocalValues(expression, boundary, [], visited, memo, captureOuter)
        .nodes.map(staticPropertyName)
        .filter((name) => name !== null)
    ),
  ];
}
export function resolvedLocalValueNodes(expression, boundary, options = {}) {
  return resolvedLocalValues(
    expression,
    boundary,
    [],
    new Set(),
    new Map(),
    options.captureOuter ?? false
  ).nodes;
}
export function resolvedLocalSelectionNodes(expression, selected, boundary, options = {}) {
  return resolvedLocalValues(
    expression,
    boundary,
    selected,
    new Set(),
    new Map(),
    options.captureOuter ?? false
  ).nodes;
}
export function resolvedLocalValueContainsReference(expression, reference, boundary, options = {}) {
  return resolvedLocalValueNodes(expression, boundary, options).some((node) => {
    const value = unwrapExpression(node);
    if (ts.isFunctionLike(value) || !containsReference(value, reference)) return false;
    let current = reference;
    while (current && current !== value) {
      if (ts.isFunctionLike(current)) return false;
      current = current.parent;
    }
    return current === value;
  });
}
export function resolvedLocalObjects(expression, boundary, options = {}) {
  return resolvedLocalValueNodes(expression, boundary, options).filter((node) =>
    ts.isObjectLiteralExpression(node)
  );
}
