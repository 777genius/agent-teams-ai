import ts from 'typescript';

import { memberAccess, unwrapExpression } from './feature-export-analysis.mjs';
import { IDENTITY_WRAPPERS } from './feature-identity-wrappers.mjs';

export function accessPath(expression) {
  let current = unwrapExpression(expression);
  const path = [];
  while (true) {
    const access = memberAccess(current);
    if (!access) break;
    path.unshift(access.name);
    current = access.receiver;
  }
  return ts.isIdentifier(current) ? { path, root: current.text } : null;
}

function directAliasPath(expression) {
  const current = unwrapExpression(expression);
  if (ts.isConditionalExpression(current)) {
    const whenTrue = directAliasPath(current.whenTrue);
    const whenFalse = directAliasPath(current.whenFalse);
    return whenTrue &&
      whenFalse &&
      whenTrue.root === whenFalse.root &&
      whenTrue.path.length === whenFalse.path.length &&
      whenTrue.path.every((segment, index) => segment === whenFalse.path[index])
      ? whenTrue
      : null;
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
      return accessPath(current.arguments[0]);
    }
  }
  return accessPath(current);
}

export function bindingAliasTargets(expression, position, bindingModel) {
  const target = accessPath(expression);
  if (!target) return [];
  const targets = [];
  const visited = new Set();
  let path = target.path;
  let sourceKey = bindingModel.bindingAt(target.root, position);
  while (sourceKey && !visited.has(sourceKey)) {
    visited.add(sourceKey);
    targets.push({ path, sourceKey });
    const binding = bindingModel.versions.get(sourceKey);
    const alias = binding && directAliasPath(binding.initializer);
    if (!binding || !alias) break;
    sourceKey = bindingModel.bindingAt(alias.root, binding.position);
    path = [...alias.path, ...path];
  }
  return targets;
}
