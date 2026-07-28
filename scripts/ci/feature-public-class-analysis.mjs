import ts from 'typescript';
// prettier-ignore
import { executionPath, immediateConstructorIifeInvocation, pathAwareWriteSequences, resolvedLocalObjects, resolvedLocalSelectionNodes, resolvedLocalValueNodes, resolvedStaticPropertyNames } from './feature-constructor-local-value-analysis.mjs';
// prettier-ignore
import { createConstructorLocalValueBudget, simpleAssignmentTerminalWriteNodes } from './feature-constructor-local-value-budget-analysis.mjs';
// prettier-ignore
import { containsReference, memberAccess, propertyNameText, unwrapExpression } from './feature-export-ast.mjs';
import { staticNullishness, staticTruthiness } from './feature-executed-iife-analysis.mjs';
import { isUnshadowedGlobalValueReference } from './feature-lexical-binding-analysis.mjs';
import { staticUndefinedness } from './feature-static-value-analysis.mjs';
// prettier-ignore
const MAX_REFERENCE_STATES = 256, MAX_LOCAL_CALL_CONTEXTS = 256, absentReferenceValue = { contains: false, nullishness: true, truthiness: false }, localInvocationReceivers = new WeakMap(), simpleTerminalWrites = new WeakMap(), staticBlockSelections = new WeakMap();
// prettier-ignore
const REFERENCE_FALSE = 1, REFERENCE_TRUE = 2, REFERENCE_ABSENT = 4;
// prettier-ignore
const logicalAssignmentKinds = new Set([ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken]);
// prettier-ignore
const isGlobalMutatorReceiver = (receiver) => ts.isIdentifier(receiver) && ['Object', 'Reflect'].includes(receiver.text) && isUnshadowedGlobalValueReference(receiver);
// prettier-ignore
const cacheStaticBlockSelection = (reference, selection) => (staticBlockSelections.set(reference, selection), selection);
// prettier-ignore
const referenceContains = (value) => typeof value === 'boolean' ? value : (value?.contains ?? false);
// prettier-ignore
function referenceValue(expression, contains) {
  if (contains) return { contains, nullishness: false, truthiness: true };
  const current = unwrapExpression(expression);
  const objectLiteral = ts.isObjectLiteralExpression(current);
  return { contains, nullishness: objectLiteral ? false : staticNullishness(current), truthiness: objectLiteral ? true : staticTruthiness(current) };
}
// prettier-ignore
const referenceStateKey = (state) => JSON.stringify([...state].sort(([left], [right]) => left.localeCompare(right)));
// prettier-ignore
const uniqueReferenceStates = (states) => [...new Map(states.map((state) => [referenceStateKey(state), state])).values()];
// prettier-ignore
function referenceStatePossibilities(states) {
  const possibilities = new Map();
  for (const state of states) for (const [name, value] of state) {
      const current = possibilities.get(name) ?? { mask: 0, present: 0 };
      current.mask |= referenceContains(value) ? REFERENCE_TRUE : REFERENCE_FALSE;
      current.present += 1;
      possibilities.set(name, current);
  }
  for (const current of possibilities.values()) if (current.present < states.length) current.mask |= REFERENCE_ABSENT;
  return possibilities;
}
// prettier-ignore
function referenceStatesFromPossibilities(possibilities) {
  const [safe, dangerous] = [new Map(), new Map()];
  let hasAbsent = false;
  for (const [name, { mask }] of possibilities) {
    if (mask & REFERENCE_ABSENT) hasAbsent = true;
    if (mask & REFERENCE_FALSE) safe.set(name, false);
    if (mask & REFERENCE_TRUE) dangerous.set(name, true);
  }
  return [hasAbsent && new Map(), safe.size > 0 && safe, dangerous.size > 0 && dangerous].filter(Boolean);
}
// prettier-ignore
function boundedReferenceStates(states) {
  const unique = uniqueReferenceStates(states);
  return unique.length <= MAX_REFERENCE_STATES ? unique : referenceStatesFromPossibilities(referenceStatePossibilities(unique));
}
// prettier-ignore
function mergeReferenceStates(states, updates) {
  const currentStates = boundedReferenceStates(states);
  const updateStates = boundedReferenceStates(updates);
  if (currentStates.length * updateStates.length <= MAX_REFERENCE_STATES) return boundedReferenceStates(currentStates.flatMap((state) => updateStates.map((update) => new Map([...state, ...update]))));
  // Dropping overflow correlation can add false positives but cannot hide a reference.
  const current = referenceStatePossibilities(currentStates);
  const update = referenceStatePossibilities(updateStates);
  const merged = new Map();
  for (const name of new Set([...current.keys(), ...update.keys()])) {
    const currentMask = current.get(name)?.mask ?? REFERENCE_ABSENT;
    const updateMask = update.get(name)?.mask ?? REFERENCE_ABSENT;
    merged.set(name, { mask: (updateMask & (REFERENCE_FALSE | REFERENCE_TRUE)) | (updateMask & REFERENCE_ABSENT ? currentMask : 0) });
  }
  return referenceStatesFromPossibilities(merged);
}
// prettier-ignore
function logicalAssignmentExecution(value, operator) {
  if (operator === ts.SyntaxKind.QuestionQuestionEqualsToken) return value?.nullishness ?? null;
  const truthiness = value?.truthiness ?? (referenceContains(value) ? true : null);
  return truthiness === null ? null : operator === ts.SyntaxKind.BarBarEqualsToken ? !truthiness : truthiness;
}
// prettier-ignore
function mergeReferenceWrite(states, write) {
  if (!logicalAssignmentKinds.has(write.operator)) return mergeReferenceStates(states, write.states);
  let outcomes = [];
  for (const state of boundedReferenceStates(states)) for (const update of boundedReferenceStates(write.states)) {
      let branches = [new Map(state)];
      for (const [name, value] of update) {
        branches = boundedReferenceStates(
          branches.flatMap((branch) => {
            const executes = logicalAssignmentExecution(branch.has(name) ? branch.get(name) : absentReferenceValue, write.operator);
            const assigned = new Map(branch).set(name, value);
            return executes === true ? [assigned] : executes === false ? [branch] : [branch, assigned];
          })
        );
      }
      outcomes = boundedReferenceStates([...outcomes, ...branches]);
  }
  return outcomes;
}
// prettier-ignore
function terminalReferenceStates(
  initialStates, writes, boundary, dangerousOnly = true, budget = createConstructorLocalValueBudget()
) {
  const allStates = [...initialStates, ...writes.flatMap(({ states }) => states)];
  const members = new Set(allStates.flatMap((state) => [...state].filter(([, value]) => !dangerousOnly || referenceContains(value)).map(([name]) => name)));
  let outcomes = [];
  for (const member of members) {
    const select = (states) => states.map((state) => new Map(state.has(member) ? [[member, state.get(member)]] : []));
    const memberWrites = writes.filter(({ states }) => states.some((state) => state.has(member))).map((write) => ({ ...write, states: select(write.states) }));
    for (const initialState of select(initialStates)) for (const sequence of pathAwareWriteSequences(memberWrites, boundary, budget)) {
        let states = [initialState];
        for (const write of sequence) states = mergeReferenceWrite(states, write);
        outcomes = boundedReferenceStates([...outcomes, ...states]);
    }
  }
  return outcomes;
}
// prettier-ignore
const hasModifier = (node, kind) => ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind);
// prettier-ignore
function isPublicStaticMember(member) {
  return member.name && !ts.isPrivateIdentifier(member.name) && hasModifier(member, ts.SyntaxKind.StaticKeyword) && !hasModifier(member, ts.SyntaxKind.PrivateKeyword) && !hasModifier(member, ts.SyntaxKind.ProtectedKeyword);
}
// prettier-ignore
const resolvedPropertyNames = (expression, boundary) => resolvedStaticPropertyNames(expression, boundary.getSourceFile(), new Set(), new Map(), true);
// prettier-ignore
function staticMemberNames(member) {
  if (!member.name) return [];
  const name = propertyNameText(member.name);
  return ts.isComputedPropertyName(member.name) ? resolvedPropertyNames(member.name.expression, member) : name === null ? [] : [name];
}
// prettier-ignore
function publicStaticMemberName(boundary, name) {
  if (name === '*') return name;
  const declaration = boundary.members.find((member) => hasModifier(member, ts.SyntaxKind.StaticKeyword) && staticMemberNames(member).includes(name));
  return !declaration || isPublicStaticMember(declaration) ? name : null;
}
// prettier-ignore
function callBindsStaticThis(invocation, staticBlock, calls, callable) {
  const aliasedReceivers = localInvocationReceivers.get(invocation)?.get(callable);
  const method = memberAccess(invocation.expression);
  const directReceiver = method && ['call', 'apply'].includes(method.name) ? invocation.arguments[0] : null;
  return (aliasedReceivers ?? [directReceiver]).some((receiver) => receiver && isStaticBlockReceiver(receiver, staticBlock, calls));
}
function isStaticBlockThis(receiver, staticBlock, calls) {
  if (receiver.kind !== ts.SyntaxKind.ThisKeyword) return false;
  let current = receiver;
  while (current.parent && current !== staticBlock) {
    const parent = current.parent;
    if (ts.isClassLike(parent)) return false;
    if (ts.isFunctionLike(parent) && !ts.isArrowFunction(parent)) {
      const immediate = immediateConstructorIifeInvocation(parent);
      const invocation = (calls?.get(parent) ?? (immediate ? [immediate] : [])).find((candidate) =>
        callBindsStaticThis(candidate, staticBlock, calls, parent)
      );
      if (!invocation) return false;
      current = invocation;
      continue;
    }
    current = parent;
  }
  return current === staticBlock;
}
// prettier-ignore
const isStaticBlockReceiver = (expression, staticBlock, calls) => resolvedLocalValueNodes(expression, staticBlock, { captureOuter: true }).some((node) => isStaticBlockThis(unwrapExpression(node), staticBlock, calls));
// prettier-ignore
function staticBlockTargetMemberName(expression, staticBlock, calls) {
  const target = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(target)) {
    if (ts.isPrivateIdentifier(target.name)) return null;
    return isStaticBlockReceiver(target.expression, staticBlock, calls) ? target.name.text : null;
  }
  if (!ts.isElementAccessExpression(target)) return null;
  if (!isStaticBlockReceiver(target.expression, staticBlock, calls)) return null;
  if (!target.argumentExpression) return '*';
  const names = resolvedPropertyNames(target.argumentExpression, staticBlock);
  return names.length === 1 ? names[0] : '*';
}
function assignmentTargetSelections(pattern, staticBlock, selected = [], fallback = null) {
  const target = unwrapExpression(pattern);
  if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
    return [{ fallback, selected, target }];
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return assignmentTargetSelections(target.left, staticBlock, selected, target.right);
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.flatMap((property) => {
      if (ts.isSpreadAssignment(property)) {
        return assignmentTargetSelections(property.expression, staticBlock, ['*', ...selected]);
      }
      if (!ts.isPropertyAssignment(property)) return [];
      const names = ts.isComputedPropertyName(property.name)
        ? resolvedPropertyNames(property.name.expression, staticBlock)
        : [propertyNameText(property.name)].filter((name) => name !== null);
      return assignmentTargetSelections(property.initializer, staticBlock, [
        ...(names.length > 0 ? names : ['*']),
        ...selected,
      ]);
    });
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element, index) => {
      if (ts.isOmittedExpression(element)) return [];
      return assignmentTargetSelections(
        ts.isSpreadElement(element) ? element.expression : element,
        staticBlock,
        [ts.isSpreadElement(element) ? '*' : String(index), ...selected]
      );
    });
  }
  return [];
}
function selectionContainsReference(source, selection, reference, staticBlock) {
  const selectedNodes = selection.selected.includes('*')
    ? []
    : resolvedLocalSelectionNodes(source, selection.selected, staticBlock, {
        captureOuter: true,
      });
  if (
    selection.fallback &&
    containsReference(selection.fallback, reference) &&
    (selectedNodes.length === 0 ||
      selectedNodes.some((node) => staticUndefinedness(unwrapExpression(node)) !== false))
  ) {
    return true;
  }
  return selection.selected.includes('*')
    ? containsReference(source, reference)
    : selectedNodes.some((node) => containsReference(node, reference));
}
function destructuringDefaultMayExecute(assignment, staticBlock) {
  let current = assignment;
  while (current.parent && current !== staticBlock) {
    const parent = current.parent;
    if (
      ts.isBinaryExpression(parent) &&
      parent !== assignment &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      containsReference(parent.left, assignment)
    ) {
      const selection = assignmentTargetSelections(parent.left, staticBlock).find(
        (candidate) =>
          candidate.fallback === assignment.right && candidate.target === assignment.left
      );
      if (!selection || selection.selected.includes('*')) return true;
      const selectedNodes = resolvedLocalSelectionNodes(
        parent.right,
        selection.selected,
        staticBlock,
        { captureOuter: true }
      );
      return (
        selectedNodes.length === 0 ||
        selectedNodes.some((node) => staticUndefinedness(unwrapExpression(node)) !== false)
      );
    }
    current = parent;
  }
  return true;
}
function valueExposesReference(expression, reference, staticBlock) {
  return resolvedLocalValueNodes(expression, staticBlock, { captureOuter: true }).some((node) =>
    containsReference(node, reference)
  );
}
function objectPropertyNames(property, staticBlock) {
  if (!property.name) return [];
  return ts.isComputedPropertyName(property.name)
    ? resolvedPropertyNames(property.name.expression, staticBlock)
    : [propertyNameText(property.name)].filter((name) => name !== null);
}
function objectPropertyExposesReference(property, reference, staticBlock) {
  if (ts.isShorthandPropertyAssignment(property)) {
    return valueExposesReference(property.name, reference, staticBlock);
  }
  if (ts.isPropertyAssignment(property)) {
    return valueExposesReference(property.initializer, reference, staticBlock);
  }
  return containsReference(property, reference);
}
function staticObjectReferenceStates(object, reference, staticBlock, visited = new Set()) {
  const key = String(object.pos) + ':' + String(object.end);
  if (visited.has(key)) return [];
  const nextVisited = new Set(visited).add(key);
  let states = [new Map()];
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spreadStates = resolvedLocalObjects(property.expression, staticBlock, {
        captureOuter: true,
      }).flatMap((spread) =>
        staticObjectReferenceStates(spread, reference, staticBlock, nextVisited)
      );
      if (spreadStates.length > 0) {
        states = mergeReferenceStates(states, spreadStates);
      }
      continue;
    }
    const contains = objectPropertyExposesReference(property, reference, staticBlock);
    const names = objectPropertyNames(property, staticBlock);
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
  return boundedReferenceStates(states);
}
function resolvedValueIdentityKeys(expression, staticBlock) {
  return new Set(
    resolvedLocalValueNodes(expression, staticBlock, { captureOuter: true }).map(
      (node) => String(node.pos) + ':' + String(node.end)
    )
  );
}
function identitiesOverlap(left, right) {
  return [...left].some((key) => right.has(key));
}
function resolvedObjectReferenceStates(expression, reference, staticBlock, beforePosition) {
  const sourceKeys = resolvedValueIdentityKeys(expression, staticBlock);
  if (sourceKeys.size === 0) return [];
  const baseStates = boundedReferenceStates(
    resolvedLocalObjects(expression, staticBlock, {
      captureOuter: true,
    }).flatMap((object) => staticObjectReferenceStates(object, reference, staticBlock))
  );
  const writes = [];
  const visit = (node) => {
    if (node.getStart() >= beforePosition || (node !== staticBlock && ts.isClassLike(node))) return;
    if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
      const contexts = staticBlockExecutionContexts(node, staticBlock);
      const target = memberAccess(node.left);
      if (
        contexts.length > 0 &&
        target &&
        identitiesOverlap(sourceKeys, resolvedValueIdentityKeys(target.receiver, staticBlock))
      ) {
        for (const context of contexts) {
          writes.push(
            contextualWrite(node, context, [
              new Map([
                [
                  target.name,
                  referenceValue(
                    node.right,
                    valueExposesReference(node.right, reference, staticBlock)
                  ),
                ],
              ]),
            ])
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(staticBlock);
  if (baseStates.length === 0 && writes.length === 0) return [];
  const initialStates = baseStates.length > 0 ? baseStates : [new Map()];
  return terminalReferenceStates(initialStates, writes, staticBlock, false);
}
function objectAssignReferenceStates(
  expressions,
  reference,
  boundary,
  staticBlock,
  beforePosition
) {
  let states = [new Map()];
  for (const expression of expressions) {
    const sourceStates = resolvedObjectReferenceStates(
      expression,
      reference,
      staticBlock,
      beforePosition
    );
    if (sourceStates.length === 0) continue;
    states = mergeReferenceStates(states, sourceStates);
  }
  return states.map((state) => {
    const publicState = new Map();
    for (const [name, contains] of state) {
      const publicName = publicStaticMemberName(boundary, name);
      if (publicName !== null) publicState.set(publicName, contains);
    }
    return publicState;
  });
}
function staticPropertyName(expression, staticBlock) {
  const names = expression ? resolvedPropertyNames(expression, staticBlock) : [];
  return names.length === 1 ? names[0] : '*';
}
function directGlobalMutatorMethod(expression) {
  const method = memberAccess(expression);
  return method &&
    ['assign', 'set', 'defineProperty', 'defineProperties'].includes(method.name) &&
    isGlobalMutatorReceiver(method.receiver)
    ? method.name
    : null;
}
function resolvedMutatorInvocations(call, staticBlock) {
  const invocations = [];
  const candidates = [
    unwrapExpression(call.expression),
    ...resolvedLocalValueNodes(call.expression, staticBlock, { captureOuter: true }).map(
      unwrapExpression
    ),
  ];
  for (const candidate of candidates) {
    const direct = directGlobalMutatorMethod(candidate);
    if (direct) invocations.push({ arguments: [...call.arguments], name: direct });
    const wrapper = memberAccess(candidate);
    if (!wrapper || !['call', 'apply'].includes(wrapper.name)) continue;
    const methods = [
      wrapper.receiver,
      ...resolvedLocalValueNodes(wrapper.receiver, staticBlock, { captureOuter: true }),
    ];
    for (const methodExpression of methods) {
      const name = directGlobalMutatorMethod(methodExpression);
      if (!name) continue;
      if (wrapper.name === 'call') {
        invocations.push({ arguments: [...call.arguments].slice(1), name });
        continue;
      }
      const argumentArrays = call.arguments[1]
        ? resolvedLocalValueNodes(call.arguments[1], staticBlock, { captureOuter: true }).filter(
            ts.isArrayLiteralExpression
          )
        : [];
      for (const argumentArray of argumentArrays) {
        if (argumentArray.elements.every((element) => !ts.isSpreadElement(element))) {
          invocations.push({ arguments: [...argumentArray.elements], name });
        }
      }
    }
  }
  return invocations;
}
function descriptorExposesReference(expression, reference, staticBlock, beforePosition) {
  return resolvedObjectReferenceStates(expression, reference, staticBlock, beforePosition).some(
    (state) =>
      [...state].some(
        ([name, value]) => ['value', 'get'].includes(name) && referenceContains(value)
      )
  );
}
function publicStaticMutatorInvocationStates(
  invocation,
  call,
  reference,
  boundary,
  staticBlock,
  calls
) {
  const args = invocation.arguments;
  if (!args[0] || !isStaticBlockReceiver(args[0], staticBlock, calls)) return [];
  if (invocation.name === 'assign') {
    return objectAssignReferenceStates(
      args.slice(1),
      reference,
      boundary,
      staticBlock,
      call.getStart()
    );
  }
  if (invocation.name === 'set' && args[2]) {
    const member = publicStaticMemberName(boundary, staticPropertyName(args[1], staticBlock));
    return member === null
      ? []
      : [new Map([[member, valueExposesReference(args[2], reference, staticBlock)]])];
  }
  if (invocation.name === 'defineProperty' && args[2]) {
    const member = publicStaticMemberName(boundary, staticPropertyName(args[1], staticBlock));
    return member === null
      ? []
      : [
          new Map([
            [member, descriptorExposesReference(args[2], reference, staticBlock, call.getStart())],
          ]),
        ];
  }
  if (invocation.name === 'defineProperties' && args[1]) {
    const states = [];
    for (const descriptors of resolvedLocalObjects(args[1], staticBlock, {
      captureOuter: true,
    })) {
      const state = new Map();
      for (const property of descriptors.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
          continue;
        }
        const names = staticMemberNames(property);
        const member = publicStaticMemberName(boundary, names.length === 1 ? names[0] : '*');
        if (member === null) continue;
        state.set(
          member,
          descriptorExposesReference(
            ts.isPropertyAssignment(property) ? property.initializer : property.name,
            reference,
            staticBlock,
            call.getStart()
          )
        );
      }
      states.push(state);
    }
    return boundedReferenceStates(states);
  }
  return [];
}
function publicStaticMutatorStates(call, reference, boundary, staticBlock, calls) {
  return boundedReferenceStates(
    resolvedMutatorInvocations(call, staticBlock).flatMap((invocation) =>
      publicStaticMutatorInvocationStates(invocation, call, reference, boundary, staticBlock, calls)
    )
  );
}
// prettier-ignore
function resolvedNodes(expression, staticBlock) {
  return expression ? [unwrapExpression(expression), ...resolvedLocalValueNodes(expression, staticBlock, { captureOuter: true }).map(unwrapExpression)] : [];
}
// prettier-ignore
const resolvedFunctionNodes = (expression, staticBlock) => resolvedNodes(expression, staticBlock).filter((node) => ts.isArrowFunction(node) || ts.isFunctionExpression(node));
// prettier-ignore
function resolvedCallArguments(expression, staticBlock) {
  return resolvedNodes(expression, staticBlock).filter(ts.isArrayLiteralExpression).filter((array) => array.elements.every((element) => !ts.isSpreadElement(element))).map((array) => [...array.elements]);
}
// prettier-ignore
function resolvedLocalCallableTargets(call, staticBlock) {
  const receivers = new Map();
  const add = (callable, receiver) => {
    const values = receivers.get(callable) ?? [];
    if (!values.includes(receiver)) receivers.set(callable, [...values, receiver]);
  };
  const method = memberAccess(call.expression);
  const methodReceiver = method && unwrapExpression(method.receiver);
  const reflectApply = method?.name === 'apply' && ts.isIdentifier(methodReceiver) && methodReceiver.text === 'Reflect' && isGlobalMutatorReceiver(methodReceiver);
  const wrapped = !reflectApply && method && ['call', 'apply'].includes(method.name);
  const target = reflectApply ? call.arguments[0] : wrapped ? method.receiver : call.expression;
  const receiver = reflectApply ? call.arguments[1] : wrapped ? call.arguments[0] : null;
  const argumentLists = reflectApply ? resolvedCallArguments(call.arguments[2], staticBlock) : method?.name === 'apply' ? resolvedCallArguments(call.arguments[1], staticBlock) : [[...call.arguments].slice(wrapped ? 1 : 0)];
  for (const callable of resolvedFunctionNodes(target, staticBlock)) add(callable, receiver);
  for (const alias of resolvedNodes(target, staticBlock)) {
    let aliasedMethod = memberAccess(alias);
    let boundArguments = [], boundReceiver = null, receiverIsBound = false;
    if (ts.isCallExpression(alias)) {
      const bind = memberAccess(alias.expression); if (bind?.name === 'bind') {
        const ordinaryCallables = resolvedFunctionNodes(bind.receiver, staticBlock); for (const callable of ordinaryCallables) add(callable, alias.arguments[0] ?? null);
        aliasedMethod = memberAccess(bind.receiver); boundReceiver = alias.arguments[0] ?? null; boundArguments = [...alias.arguments].slice(1); receiverIsBound = true; if (!aliasedMethod || alias.arguments.length === 0) continue;
      } else aliasedMethod = null;
    }
    if (!aliasedMethod || !['call', 'apply'].includes(aliasedMethod.name)) continue;
    for (const callable of resolvedFunctionNodes(aliasedMethod.receiver, staticBlock)) {
      if (!resolvedFunctionNodes(receiverIsBound ? boundReceiver : receiver, staticBlock).includes(callable)) continue;
      for (const arguments_ of argumentLists) add(callable, [...boundArguments, ...arguments_][0] ?? null);
    }
  }
  localInvocationReceivers.set(call, receivers);
  return [...receivers.keys()];
}
function localStaticBlockFunctionInvocations(callable, staticBlock) {
  const invocations = [];
  const visit = (node) => {
    if (node === callable || (node !== staticBlock && ts.isClassLike(node))) {
      return;
    }
    if (
      ts.isCallExpression(node) &&
      resolvedLocalCallableTargets(node, staticBlock).includes(callable)
    ) {
      invocations.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(staticBlock, visit);
  return invocations;
}
function contextReceiverKind(context, node, staticBlock) {
  const paths = context.pathNodes.map((pathNode) => executionPath(pathNode, staticBlock));
  const depth = Math.min(
    paths.reduce((size, { constraints }) => size + constraints.size, 0),
    MAX_LOCAL_CALL_CONTEXTS / 8 - 1
  );
  const kind = `${paths.every(({ reachable }) => reachable)}:${depth}`;
  for (let current = node.parent; current && current !== staticBlock; current = current.parent) {
    if (!ts.isFunctionLike(current) || ts.isArrowFunction(current)) continue;
    return `${kind}:${(context.calls.get(current) ?? []).some((invocation) =>
      callBindsStaticThis(invocation, staticBlock, context.calls, current)
    )}`;
  }
  return `${kind}:true`;
}
function boundedExecutionContexts(contexts, node, staticBlock) {
  if (contexts.length <= MAX_LOCAL_CALL_CONTEXTS) return contexts;
  const groups = new Map();
  for (const context of contexts) {
    const key = contextReceiverKind(context, node, staticBlock);
    groups.set(key, [...(groups.get(key) ?? []), context]);
  }
  const bounded = [];
  for (const group of groups.values()) {
    group.sort((left, right) => left.position - right.position);
    bounded.push(group[0]);
    if (group.at(-1) !== group[0]) bounded.push(group.at(-1));
  }
  return bounded;
}
function staticBlockExecutionContexts(node, staticBlock, visiting = new Set()) {
  let callable = null;
  for (let current = node.parent; current && current !== staticBlock; current = current.parent) {
    if (ts.isClassLike(current)) return [];
    if (ts.isFunctionLike(current)) {
      callable = current;
      break;
    }
  }
  if (!callable) {
    return [{ calls: new Map(), pathNodes: [node], position: node.getStart() }];
  }
  if (visiting.has(callable)) return [];
  const immediate = immediateConstructorIifeInvocation(callable);
  const invocations = immediate
    ? [immediate]
    : localStaticBlockFunctionInvocations(callable, staticBlock);
  const nextVisiting = new Set(visiting).add(callable);
  let contexts = [];
  for (const invocation of invocations) {
    for (const outer of staticBlockExecutionContexts(invocation, staticBlock, nextVisiting)) {
      contexts.push({
        calls: new Map(outer.calls).set(callable, [invocation]),
        pathNodes: [node, ...outer.pathNodes],
        position: outer.position,
      });
      contexts = boundedExecutionContexts(contexts, node, staticBlock);
    }
  }
  return contexts;
}
// prettier-ignore
function contextualWrite(node, context, states) {
  return { key: `${node.pos}:${node.end}:${context.pathNodes.map(({ pos }) => pos).join(':')}`, node, pathNodes: context.pathNodes, position: context.position, operator: ts.isBinaryExpression(node) ? node.operatorToken.kind : ts.SyntaxKind.EqualsToken, states };
}
// prettier-ignore
function containingReferenceAssignment(reference, staticBlock) {
  for (let current = reference; current.parent && current.parent !== staticBlock; current = current.parent) {
    const parent = current.parent;
    if (!ts.isBinaryExpression(parent) || !ts.isAssignmentOperator(parent.operatorToken.kind) || !containsReference(parent.right, current)) continue;
    return parent;
  }
  return null;
}
// prettier-ignore
function directReferenceMember(reference, boundary, staticBlock) {
  const assignment = containingReferenceAssignment(reference, staticBlock);
  const member = assignment && staticBlockTargetMemberName(assignment.left, staticBlock);
  return member === null ? null : publicStaticMemberName(boundary, member);
}
// prettier-ignore
function simpleDirectTerminalWrites(staticBlock, member) {
  let members = simpleTerminalWrites.get(staticBlock);
  if (!members) simpleTerminalWrites.set(staticBlock, (members = new Map()));
  if (members.has(member)) return members.get(member);
  const terminal = simpleAssignmentTerminalWriteNodes(staticBlock, (node) => {
    if (staticBlockTargetMemberName(node.left, staticBlock) !== member) return null;
    const contexts = staticBlockExecutionContexts(node, staticBlock);
    return node.operatorToken.kind === ts.SyntaxKind.EqualsToken && contexts.length === 1 && contexts[0].calls.size === 0
      ? { ...contextualWrite(node, contexts[0], [new Map()]), path: executionPath(node, staticBlock) } : false;
  });
  members.set(member, terminal);
  return terminal;
}
// prettier-ignore
function simpleDirectStaticBlockSelection(reference, directMember, staticBlock) {
  if (directMember === null) return undefined;
  const origin = containingReferenceAssignment(reference, staticBlock);
  if (!origin || origin.operatorToken.kind !== ts.SyntaxKind.EqualsToken || unwrapExpression(origin.right) !== reference) return undefined;
  const terminal = simpleDirectTerminalWrites(staticBlock, directMember);
  if (terminal === null) return undefined;
  return terminal.has(origin) ? { getterOnly: false, localMember: directMember } : null;
}
// prettier-ignore
function hasDefiniteLaterDirectWrite(reference, member, staticBlock) {
  if (member === null) return false;
  const origin = containingReferenceAssignment(reference, staticBlock);
  if (!origin) return false;
  const originContexts = staticBlockExecutionContexts(origin, staticBlock);
  if (originContexts.length === 0) return false;
  const overwritePositions = [];
  const definiteContext = (context) => context.pathNodes.every((pathNode) => { const path = executionPath(pathNode, staticBlock); return path.reachable && path.constraints.size === 0; });
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      for (const context of staticBlockExecutionContexts(node, staticBlock)) if (definiteContext(context) && staticBlockTargetMemberName(node.left, staticBlock, context.calls) === member) overwritePositions.push(context.position);
    }
    ts.forEachChild(node, visit);
  };
  visit(staticBlock);
  return originContexts.every((context) => overwritePositions.some((position) => position > context.position));
}
// prettier-ignore
function terminalStaticBlockSelection(reference, boundary, staticBlock, directMember) {
  const writes = [];
  const visit = (node) => {
    if (node !== staticBlock && ts.isClassLike(node)) return;
    if (
      ts.isBinaryExpression(node) &&
      ts.isAssignmentOperator(node.operatorToken.kind) &&
      destructuringDefaultMayExecute(node, staticBlock)
    ) {
      const directTarget = memberAccess(node.left);
      if (directMember !== null && directTarget && directTarget.name !== directMember) {
        ts.forEachChild(node, visit); return;
      }
      for (const context of staticBlockExecutionContexts(node, staticBlock)) {
        const state = new Map();
        for (const target of assignmentTargetSelections(node.left, staticBlock)) {
          const member = staticBlockTargetMemberName(target.target, staticBlock, context.calls);
          if (member === null) continue;
          const publicMember = publicStaticMemberName(boundary, member);
          if (publicMember === null) continue;
          state.set(publicMember, referenceValue(node.right, selectionContainsReference(node.right, target, reference, staticBlock)));
        }
        if (state.size > 0) writes.push(contextualWrite(node, context, [state]));
      }
    }
    if (ts.isCallExpression(node)) {
      for (const context of staticBlockExecutionContexts(node, staticBlock)) {
        const states = publicStaticMutatorStates(node, reference, boundary, staticBlock, context.calls);
        if (states.length > 0) writes.push(contextualWrite(node, context, states));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(staticBlock);
  const budget = createConstructorLocalValueBudget();
  for (const state of terminalReferenceStates([new Map()], writes, staticBlock, true, budget)) {
    for (const [localMember, value] of state) {
      if (referenceContains(value)) return { getterOnly: false, localMember };
    }
  }
  return null;
}
// prettier-ignore
function publicStaticBlockWriteSelection(reference, boundary) {
  if (staticBlockSelections.has(reference)) return staticBlockSelections.get(reference);
  let staticBlock = reference;
  while (staticBlock.parent && staticBlock.parent !== boundary) staticBlock = staticBlock.parent;
  if (staticBlock.parent !== boundary || !ts.isClassStaticBlockDeclaration(staticBlock)) return null;
  let current = reference;
  while (current.parent && current.parent !== staticBlock) {
    const parent = current.parent;
    if (ts.isBinaryExpression(parent) && ts.isAssignmentOperator(parent.operatorToken.kind)) {
      if (containsReference(parent.right, current)) break;
      if (containsReference(parent.left, current)) return cacheStaticBlockSelection(reference, null);
    }
    const controlReference = (ts.isIfStatement(parent) && containsReference(parent.expression, current)) || (ts.isConditionalExpression(parent) && containsReference(parent.condition, current)) || (ts.isIterationStatement(parent, false) && !containsReference(parent.statement, current));
    if (controlReference) return cacheStaticBlockSelection(reference, null);
    current = parent;
  }
  const directMember = directReferenceMember(reference, boundary, staticBlock);
  const simpleSelection = simpleDirectStaticBlockSelection(reference, directMember, staticBlock);
  const selection = hasDefiniteLaterDirectWrite(reference, directMember, staticBlock) ? null
    : simpleSelection !== undefined ? simpleSelection
      : terminalStaticBlockSelection(reference, boundary, staticBlock, directMember);
  return cacheStaticBlockSelection(reference, selection);
}
export function publicStaticClassSelection(reference, boundary) {
  const staticBlockSelection = publicStaticBlockWriteSelection(reference, boundary);
  if (staticBlockSelection) return staticBlockSelection;
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
