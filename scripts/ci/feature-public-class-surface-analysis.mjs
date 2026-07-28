import ts from 'typescript';

import {
  hasModifier,
  isIdentifierReference,
  propertyNameText,
  unwrapExpression,
} from './feature-export-analysis.mjs';
import { visitDefiniteTopLevelExpressions } from './feature-definite-execution.mjs';
import { isPotentiallyExecutedAtTopLevel } from './feature-executed-iife-analysis.mjs';
import {
  executionPath,
  resolvedLocalValueNodes,
} from './feature-constructor-local-value-analysis.mjs';
import { publicStaticClassSelection } from './feature-public-class-analysis.mjs';
import { publicConstructorSelection } from './feature-public-constructor-analysis.mjs';
import {
  propertyWriteAvailableAt,
  propertyWriteWasOverwrittenBefore,
} from './feature-public-object-analysis.mjs';

const DIRECT_CLASS_SURFACE = Object.freeze({
  constructorSignature: true,
  heritage: true,
  instance: true,
  static: true,
  typeParameters: true,
});
const INSTANCE_CLASS_SURFACE = Object.freeze({
  constructorSignature: false,
  heritage: true,
  instance: true,
  static: false,
  typeParameters: false,
});
const UNREACHABLE_CLASS_SELECTION = Object.freeze({
  getterOnly: true,
  localMember: '*',
});

function classBoundaries(expression) {
  const current = unwrapExpression(expression);
  if (ts.isClassExpression(current)) return [current];
  if (ts.isConditionalExpression(current)) {
    return [...classBoundaries(current.whenTrue), ...classBoundaries(current.whenFalse)];
  }
  return [];
}

function assignmentToIdentifier(node) {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return null;
  }
  const target = unwrapExpression(node.left);
  return ts.isIdentifier(target) ? target.text : null;
}

function classBindingContainerStatements(container) {
  return ts.isCaseBlock(container)
    ? container.clauses.flatMap((clause) => [...clause.statements])
    : [...container.statements];
}

function collectClassBindingEvents(container) {
  const sourceFile = container.getSourceFile();
  const statements = classBindingContainerStatements(container);
  const eventsByName = new Map();
  const definiteAssignments = new Set();
  let sequence = 0;
  const addEvent = (name, boundaries, position, definite = true) => {
    const events = eventsByName.get(name) ?? [];
    events.push({ boundaries, definite, position, sequence: sequence++ });
    eventsByName.set(name, events);
  };

  if (!ts.isCaseBlock(container)) {
    visitDefiniteTopLevelExpressions(container, (node) => {
      if (assignmentToIdentifier(node)) definiteAssignments.add(node);
    });
  }

  for (const statement of statements) {
    if (ts.isClassDeclaration(statement) && statement.name) {
      addEvent(statement.name.text, [statement], statement.getStart(sourceFile));
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      addEvent(
        declaration.name.text,
        classBoundaries(declaration.initializer),
        declaration.getStart(sourceFile)
      );
    }
  }

  const visitAssignment = (node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    const name = assignmentToIdentifier(node);
    if (name) {
      addEvent(name, classBoundaries(node.right), node.end, definiteAssignments.has(node));
    }
    ts.forEachChild(node, visitAssignment);
  };
  for (const statement of statements) {
    if (!ts.isClassDeclaration(statement) && !ts.isVariableStatement(statement)) {
      visitAssignment(statement);
    }
  }

  for (const events of eventsByName.values()) {
    events.sort((left, right) => left.position - right.position || left.sequence - right.sequence);
  }
  return eventsByName;
}

function classBindingsAt(eventsByName, name, position) {
  let boundaries = new Set();
  for (const event of eventsByName.get(name) ?? []) {
    if (event.position > position) break;
    if (event.definite) {
      boundaries = new Set(event.boundaries);
    } else {
      for (const boundary of event.boundaries) boundaries.add(boundary);
    }
  }
  return boundaries;
}

function mergeSurface(existing, next) {
  if (!existing) return { ...next };
  return {
    constructorSignature: existing.constructorSignature || next.constructorSignature,
    heritage: existing.heritage || next.heritage,
    instance: existing.instance || next.instance,
    static: existing.static || next.static,
    typeParameters: existing.typeParameters || next.typeParameters,
  };
}

function localBaseBoundaries(boundary, eventsByName) {
  const heritage = boundary.heritageClauses?.find(
    ({ token }) => token === ts.SyntaxKind.ExtendsKeyword
  );
  const expression = heritage?.types[0]?.expression;
  const base = expression && unwrapExpression(expression);
  return base && ts.isIdentifier(base)
    ? classBindingsAt(eventsByName, base.text, boundary.getStart())
    : new Set();
}

function nearestClassBoundary(reference) {
  let current = reference.parent;
  while (current) {
    if (ts.isClassLike(current)) return current;
    current = current.parent;
  }
  return null;
}

function nearestFunctionDeclaration(reference) {
  let current = reference.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current)) return current;
    if (ts.isClassLike(current)) return null;
    current = current.parent;
  }
  return null;
}

function isPublicMember(member) {
  return (
    (!('name' in member) || !member.name || !ts.isPrivateIdentifier(member.name)) &&
    !hasModifier(member, ts.SyntaxKind.PrivateKeyword) &&
    !hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
  );
}

function isStaticMember(member) {
  return hasModifier(member, ts.SyntaxKind.StaticKeyword);
}

function containsReference(node, reference) {
  return reference.pos >= node.pos && reference.end <= node.end;
}

function containingClassMember(reference, boundary) {
  let current = reference;
  while (current.parent && current.parent !== boundary) current = current.parent;
  return current.parent === boundary ? current : null;
}

function referenceIsInBody(reference, member) {
  return Boolean(member.body && containsReference(member.body, reference));
}

function publicSignatureSelection(reference, boundary, surface) {
  const heritage = boundary.heritageClauses?.find((clause) => containsReference(clause, reference));
  if (heritage && surface.heritage) {
    return { getterOnly: false, localMember: '*' };
  }
  const typeParameter = boundary.typeParameters?.find((parameter) =>
    containsReference(parameter, reference)
  );
  if (typeParameter && surface.typeParameters) {
    return { getterOnly: false, localMember: '*' };
  }
  const member = containingClassMember(reference, boundary);
  if (!member) return null;
  if (ts.isIndexSignatureDeclaration(member)) {
    return surface.instance && isPublicMember(member)
      ? { getterOnly: false, localMember: '*' }
      : null;
  }
  if (ts.isConstructorDeclaration(member)) {
    if (
      surface.constructorSignature &&
      isPublicMember(member) &&
      !referenceIsInBody(reference, member)
    ) {
      return { getterOnly: false, localMember: '*' };
    }
    return null;
  }
  if (!('name' in member) || !member.name || !isPublicMember(member)) return null;
  const selectedSurface = isStaticMember(member) ? surface.static : surface.instance;
  if (!selectedSurface || referenceIsInBody(reference, member)) return null;
  return {
    getterOnly: false,
    localMember: propertyNameText(member.name),
  };
}

function publicClassSelection(reference, boundary, surface) {
  if (surface.instance) {
    const instanceSelection = publicConstructorSelection(reference, boundary);
    if (instanceSelection) return instanceSelection;
  }
  if (surface.static) {
    const staticSelection = publicStaticClassSelection(reference, boundary);
    if (staticSelection) return staticSelection;
  }
  return publicSignatureSelection(reference, boundary, surface);
}

const scopedClassBindingEvents = new WeakMap();

function nearestClassBindingContainer(node) {
  let current = node.parent;
  while (current) {
    if (ts.isBlock(current) || ts.isCaseBlock(current) || ts.isSourceFile(current)) return current;
    current = current.parent;
  }
  return null;
}

function classBindingForBoundary(boundary) {
  const container = nearestClassBindingContainer(boundary);
  if (!container) return null;
  let eventsByName = scopedClassBindingEvents.get(container);
  if (!eventsByName) {
    eventsByName = collectClassBindingEvents(container);
    scopedClassBindingEvents.set(container, eventsByName);
  }
  for (const [name, events] of eventsByName) {
    if (events.some(({ boundaries }) => boundaries.includes(boundary))) {
      return { container, eventsByName, name };
    }
  }
  return null;
}

function enclosingPublicClassSelection(reference, surfaces) {
  let current = reference.parent;
  while (current) {
    if (ts.isClassLike(current)) {
      const surface = surfaces.get(current);
      if (surface) {
        const selection = publicClassSelection(reference, current, surface);
        if (selection) return selection;
      }
    }
    current = current.parent;
  }
  return null;
}

function containerDeclaresBinding(container, name) {
  return classBindingContainerStatements(container).some((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some((declaration) =>
        bindingNames(declaration.name).includes(name)
      );
    }
    return (
      (ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === name
    );
  });
}

const MAX_NESTED_CLASS_EXPOSURE_STEPS = 256;
const nestedBoundarySelections = new WeakMap();

function classBoundaryReaches(candidate, target, visiting, budget) {
  if (candidate === target) return true;
  if (visiting.has(candidate) || budget.remaining-- <= 0) return false;
  const binding = classBindingForBoundary(candidate);
  return (
    binding !== null &&
    [...localBaseBoundaries(candidate, binding.eventsByName)].some((base) =>
      classBoundaryReaches(base, target, new Set(visiting).add(candidate), budget)
    )
  );
}

function resolvedValueReachesBoundary(expression, target, binding, budget) {
  return resolvedLocalValueNodes(expression, binding.container, { captureOuter: true }).some(
    (node) => {
      const value = unwrapExpression(node);
      const candidates = ts.isClassLike(value)
        ? [value]
        : ts.isIdentifier(value)
          ? [...classBindingsAt(binding.eventsByName, value.text, value.getStart())]
          : [];
      return candidates.some((candidate) =>
        classBoundaryReaches(candidate, target, new Set(), budget)
      );
    }
  );
}

function nestedBoundarySelection(boundary, surfaces, visiting, budget) {
  if (nestedBoundarySelections.has(boundary)) return nestedBoundarySelections.get(boundary);
  if (visiting.has(boundary) || budget.remaining-- <= 0) return undefined;
  const binding = classBindingForBoundary(boundary);
  if (!binding) return null;
  let exposedSelection = null;
  const visit = (node) => {
    if (exposedSelection || budget.remaining-- <= 0 || node === boundary) return;
    if (
      ts.isIdentifier(node) &&
      node.text === binding.name &&
      isIdentifierReference(node) &&
      classBindingsAt(binding.eventsByName, binding.name, node.getStart()).has(boundary)
    ) {
      const referenceContainer = nearestClassBindingContainer(node);
      if (
        referenceContainer !== binding.container &&
        referenceContainer &&
        containerDeclaresBinding(referenceContainer, binding.name)
      ) {
        return;
      }
      exposedSelection = enclosingPublicClassSelection(node, surfaces);
      if (!exposedSelection) {
        const derived = nearestClassBoundary(node);
        if (
          derived &&
          derived !== boundary &&
          derived.heritageClauses?.some((clause) => containsReference(clause, node))
        ) {
          exposedSelection = nestedBoundarySelection(
            derived,
            surfaces,
            new Set(visiting).add(boundary),
            budget
          );
        }
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      const selection = enclosingPublicClassSelection(node, surfaces);
      if (selection && resolvedValueReachesBoundary(node, boundary, binding, budget)) {
        exposedSelection = selection;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(binding.container);
  const selection = exposedSelection ?? (budget.remaining < 0 ? undefined : null);
  if (selection !== undefined) nestedBoundarySelections.set(boundary, selection);
  return selection;
}

function nestedClassSelection(reference, boundary, surfaces) {
  const directSelection = enclosingPublicClassSelection(reference, surfaces);
  if (directSelection) return { selection: directSelection };
  let hasPublicAncestor = false;
  for (let current = boundary.parent; current; current = current.parent) {
    if (ts.isClassLike(current) && surfaces.has(current)) {
      hasPublicAncestor = true;
      break;
    }
  }
  if (!hasPublicAncestor) return undefined;
  const selection = nestedBoundarySelection(boundary, surfaces, new Set(), {
    remaining: MAX_NESTED_CLASS_EXPOSURE_STEPS,
  });
  return selection === undefined ? undefined : { selection };
}

function directAnonymousClasses(sourceFile) {
  const boundaries = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isClassDeclaration(statement) &&
      !statement.name &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      boundaries.push(statement);
    } else if (ts.isExportAssignment(statement)) {
      boundaries.push(...classBoundaries(statement.expression));
    }
  }
  return boundaries;
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : []
  );
}

function liveExportedLocalNames(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        names.add(element.propertyName?.text ?? element.name.text);
      }
      continue;
    }
    if (
      !hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
      hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) names.add(name);
      }
    }
  }
  return names;
}

function publicPrototypeWriteSelection(
  reference,
  propertyWrites,
  publicConstructorBindingNames,
  prototypeRelations,
  sourceFile
) {
  const referenceIsInGetter = (() => {
    let current = reference.parent;
    while (current && current !== sourceFile) {
      if (ts.isGetAccessorDeclaration(current)) return true;
      if (ts.isFunctionLike(current)) {
        let callable = current;
        while (
          callable.parent &&
          (ts.isParenthesizedExpression(callable.parent) ||
            ts.isAsExpression(callable.parent) ||
            ts.isTypeAssertionExpression(callable.parent) ||
            ts.isNonNullExpression(callable.parent) ||
            ts.isSatisfiesExpression(callable.parent))
        ) {
          callable = callable.parent;
        }
        return (
          ts.isPropertyAssignment(callable.parent) &&
          propertyNameText(callable.parent.name) === 'get'
        );
      }
      current = current.parent;
    }
    return false;
  })();
  if (!isPotentiallyExecutedAtTopLevel(reference, sourceFile) && !referenceIsInGetter) {
    return null;
  }
  const position = reference.getStart();
  const pathEquals = (left, right) =>
    left.length === right.length && left.every((segment, index) => segment === right[index]);
  const pathStartsWith = (path, prefix) =>
    prefix.every((segment, index) => path[index] === segment);
  const writeContainsReference = (write) =>
    write.referenceRanges?.some((range) => range.start <= position && position <= range.end);
  const liveWrites = (writes, prefix) =>
    writes.filter(
      (write) =>
        pathStartsWith(write.path, prefix) &&
        !propertyWriteWasOverwrittenBefore(writes, write, Number.POSITIVE_INFINITY)
    );
  const targetWasReplacedAfter = (relation) =>
    (propertyWrites.get(relation.ownerKey) ?? []).some(
      (write) =>
        propertyWriteAvailableAt(write) > relation.position &&
        write.path.length <= relation.targetPath.length &&
        pathStartsWith(relation.targetPath, write.path)
    );
  const latestRelation = (ownerKey, targetPath) =>
    prototypeRelations
      .filter(
        (relation) => relation.ownerKey === ownerKey && pathEquals(relation.targetPath, targetPath)
      )
      .sort((left, right) => right.position - left.position || right.sequence - left.sequence)
      .find((relation) => !targetWasReplacedAfter(relation));

  for (const [bindingKey, localName] of publicConstructorBindingNames) {
    const blockedMembers = new Set();
    const visited = new Set();
    let surface = {
      inlineWrites: null,
      path: ['prototype'],
      sourceKey: bindingKey,
    };
    while (surface) {
      const surfaceKey = surface.inlineWrites
        ? `inline:${surface.inlineWrites[0]?.position ?? 'empty'}`
        : `${surface.sourceKey}:${JSON.stringify(surface.path)}`;
      if (visited.has(surfaceKey)) break;
      visited.add(surfaceKey);

      const allWrites = surface.inlineWrites ?? propertyWrites.get(surface.sourceKey) ?? [];
      const currentWrites = liveWrites(allWrites, surface.path);
      for (const write of currentWrites) {
        const relativePath = write.path.slice(surface.path.length);
        const member = relativePath[0] ?? '*';
        if (!write.removed && !blockedMembers.has(member) && writeContainsReference(write)) {
          return {
            localName,
            selection: {
              getterOnly: false,
              localMember: member,
            },
          };
        }
      }

      for (const write of currentWrites) {
        const relativePath = write.path.slice(surface.path.length);
        if (!write.removed && relativePath.length === 1 && relativePath[0] !== '*') {
          blockedMembers.add(relativePath[0]);
        }
      }

      if (surface.inlineWrites) break;
      const relation = latestRelation(surface.sourceKey, surface.path);
      if (!relation) break;
      surface = relation.sourceKey
        ? {
            inlineWrites: null,
            path: relation.path,
            sourceKey: relation.sourceKey,
          }
        : relation.inlineWrites?.length
          ? {
              inlineWrites: relation.inlineWrites,
              path: [],
              sourceKey: null,
            }
          : null;
    }
  }
  return null;
}

export function analyzePublicClassSurfaces({
  constructorExports,
  exportedLocalNames,
  propertyWrites,
  prototypeRelations = [],
  sourceFile,
}) {
  const eventsByName = collectClassBindingEvents(sourceFile);
  const publicFunctionConstructorNames = new Set(
    constructorExports.map(({ localName }) => localName)
  );
  const publicConstructorBindingNames = new Map(
    constructorExports
      .filter(({ bindingKey }) => bindingKey)
      .map(({ bindingKey, localName }) => [bindingKey, localName])
  );
  const liveExportNames = liveExportedLocalNames(sourceFile);
  const snapshotExports = sourceFile.statements.flatMap((statement) => {
    if (!ts.isExportAssignment(statement)) return [];
    const expression = unwrapExpression(statement.expression);
    return ts.isIdentifier(expression)
      ? [{ name: expression.text, position: statement.getStart(sourceFile) }]
      : [];
  });
  const snapshotExportNames = new Set(snapshotExports.map(({ name }) => name));
  const surfaces = new Map();
  const candidates = new Set();
  const addSurface = (boundary, surface) => {
    candidates.add(boundary);
    const merged = mergeSurface(surfaces.get(boundary), surface);
    const changed = JSON.stringify(merged) !== JSON.stringify(surfaces.get(boundary));
    surfaces.set(boundary, merged);
    return changed;
  };

  for (const name of exportedLocalNames) {
    for (const event of eventsByName.get(name) ?? []) {
      for (const boundary of event.boundaries) candidates.add(boundary);
    }
    if (!snapshotExportNames.has(name) || liveExportNames.has(name)) {
      for (const boundary of classBindingsAt(eventsByName, name, Infinity)) {
        addSurface(boundary, DIRECT_CLASS_SURFACE);
      }
    }
  }
  for (const snapshot of snapshotExports) {
    for (const boundary of classBindingsAt(eventsByName, snapshot.name, snapshot.position)) {
      addSurface(boundary, DIRECT_CLASS_SURFACE);
    }
  }
  for (const boundary of directAnonymousClasses(sourceFile)) {
    addSurface(boundary, DIRECT_CLASS_SURFACE);
  }
  for (const { localName, position = Infinity } of constructorExports) {
    for (const boundary of classBindingsAt(eventsByName, localName, position)) {
      addSurface(boundary, INSTANCE_CLASS_SURFACE);
    }
  }

  const queue = [...surfaces.keys()];
  while (queue.length > 0) {
    const boundary = queue.shift();
    const surface = surfaces.get(boundary);
    const inheritedSurface = {
      ...INSTANCE_CLASS_SURFACE,
      constructorSignature:
        surface.constructorSignature &&
        !boundary.members.some((member) => ts.isConstructorDeclaration(member)),
      static: surface.static,
    };
    for (const base of localBaseBoundaries(boundary, eventsByName)) {
      if (addSurface(base, inheritedSurface)) queue.push(base);
    }
  }

  const staleBoundaries = new Set([...candidates].filter((boundary) => !surfaces.has(boundary)));
  return {
    classifyReference: (reference) => {
      if (!executionPath(reference, sourceFile).reachable) {
        return { selection: UNREACHABLE_CLASS_SELECTION };
      }
      const boundary = nearestClassBoundary(reference);
      if (boundary) {
        const surface = surfaces.get(boundary);
        if (surface) {
          return {
            selection: publicClassSelection(reference, boundary, surface),
          };
        }
        return staleBoundaries.has(boundary)
          ? { selection: null }
          : nestedClassSelection(reference, boundary, surfaces);
      }
      const prototypeSelection = publicPrototypeWriteSelection(
        reference,
        propertyWrites,
        publicConstructorBindingNames,
        prototypeRelations,
        sourceFile
      );
      if (prototypeSelection) {
        return prototypeSelection;
      }
      const functionBoundary = nearestFunctionDeclaration(reference);
      return functionBoundary?.name &&
        publicFunctionConstructorNames.has(functionBoundary.name.text)
        ? {
            selection: publicConstructorSelection(reference, functionBoundary),
          }
        : undefined;
    },
  };
}
