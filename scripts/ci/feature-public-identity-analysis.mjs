import ts from 'typescript';

import {
  memberAccess,
  rootBindingName,
  unwrapExpression,
} from './feature-export-analysis.mjs';
import { IDENTITY_WRAPPERS } from './feature-identity-wrappers.mjs';

export { IDENTITY_WRAPPERS };

export function constructedClassReferences(expression) {
  const current = unwrapExpression(expression);
  if (ts.isNewExpression(current)) {
    const className = rootBindingName(current.expression);
    return className
      ? [{ localName: className, position: current.expression.getStart() }]
      : [];
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.flatMap((property) =>
      ts.isPropertyAssignment(property)
        ? constructedClassReferences(property.initializer)
        : []
    );
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : constructedClassReferences(element)
    );
  }
  if (ts.isConditionalExpression(current)) {
    return [
      ...constructedClassReferences(current.whenTrue),
      ...constructedClassReferences(current.whenFalse),
    ];
  }
  if (ts.isCallExpression(current)) {
    const method = memberAccess(current.expression);
    if (
      method &&
      ts.isIdentifier(method.receiver) &&
      method.receiver.text === 'Object' &&
      IDENTITY_WRAPPERS.has(method.name) &&
      current.arguments[0]
    ) {
      return constructedClassReferences(current.arguments[0]);
    }
  }
  return [];
}

export function constructedClassNames(expression) {
  return constructedClassReferences(expression).map(({ localName }) => localName);
}

export function directlyExportedClassNames(sourceFile, exportedLocalNames) {
  return sourceFile.statements.flatMap((statement) =>
    ts.isClassDeclaration(statement) &&
    statement.name &&
    exportedLocalNames.has(statement.name.text)
      ? [statement.name.text]
      : []
  );
}
