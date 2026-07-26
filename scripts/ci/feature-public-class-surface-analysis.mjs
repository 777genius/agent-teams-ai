import ts from 'typescript';

import {
  hasModifier,
  propertyNameText,
  unwrapExpression,
} from './feature-export-analysis.mjs';
import { visitDefiniteTopLevelExpressions } from './feature-definite-execution.mjs';
import { publicStaticClassSelection } from './feature-public-class-analysis.mjs';
import { publicConstructorSelection } from './feature-public-constructor-analysis.mjs';

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

function classBoundaries(expression) {
  const current = unwrapExpression(expression);
  if (ts.isClassExpression(current)) return [current];
  if (ts.isConditionalExpression(current)) {
    return [
      ...classBoundaries(current.whenTrue),
      ...classBoundaries(current.whenFalse),
    ];
  }
  return [];
}

function assignmentToIdentifier(node) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return null;
  }
  const target = unwrapExpression(node.left);
  return ts.isIdentifier(target) ? target.text : null;
}

function collectClassBindingEvents(sourceFile) {
  const eventsByName = new Map();
  const definiteAssignments = new Set();
  let sequence = 0;
  const addEvent = (name, boundaries, position, definite = true) => {
    const events = eventsByName.get(name) ?? [];
    events.push({ boundaries, definite, position, sequence: sequence++ });
    eventsByName.set(name, events);
  };

  visitDefiniteTopLevelExpressions(sourceFile, (node) => {
    if (assignmentToIdentifier(node)) definiteAssignments.add(node);
  });

  for (const statement of sourceFile.statements) {
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
      addEvent(
        name,
        classBoundaries(node.right),
        node.end,
        definiteAssignments.has(node)
      );
    }
    ts.forEachChild(node, visitAssignment);
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) && !ts.isVariableStatement(statement)) {
      visitAssignment(statement);
    }
  }

  for (const events of eventsByName.values()) {
    events.sort(
      (left, right) =>
        left.position - right.position || left.sequence - right.sequence
    );
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
    constructorSignature:
      existing.constructorSignature || next.constructorSignature,
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
  const heritage = boundary.heritageClauses?.find((clause) =>
    containsReference(clause, reference)
  );
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

export function analyzePublicClassSurfaces({
  constructorExports,
  exportedLocalNames,
  sourceFile,
}) {
  const eventsByName = collectClassBindingEvents(sourceFile);
  const publicFunctionConstructorNames = new Set(
    constructorExports.map(({ localName }) => localName)
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
    const changed =
      JSON.stringify(merged) !== JSON.stringify(surfaces.get(boundary));
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
    for (const boundary of classBindingsAt(
      eventsByName,
      snapshot.name,
      snapshot.position
    )) {
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

  const staleBoundaries = new Set(
    [...candidates].filter((boundary) => !surfaces.has(boundary))
  );
  return {
    classifyReference: (reference) => {
      const boundary = nearestClassBoundary(reference);
      if (boundary) {
        const surface = surfaces.get(boundary);
        if (surface) {
          return {
            selection: publicClassSelection(reference, boundary, surface),
          };
        }
        return staleBoundaries.has(boundary) ? { selection: null } : undefined;
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
