import ts from 'typescript';

import { memberAccess, unwrapExpression } from './feature-export-analysis.mjs';
import { visitDefiniteTopLevelExpressions } from './feature-definite-execution.mjs';
import { isUnshadowedGlobalValueReference } from './feature-lexical-binding-analysis.mjs';
import { bindingAliasTargets } from './feature-public-access-path.mjs';
import { collectOrdinaryPropertyDefinitions } from './feature-public-object-state.mjs';

export function collectPrototypeRelations(sourceFile, bindingModel) {
  const relations = [];
  let sequence = 0;
  const relationSource = (expression, position) => {
    const source = bindingAliasTargets(expression, position, bindingModel).at(-1);
    if (source) {
      return {
        path: source.path,
        sourceKey: source.sourceKey,
      };
    }
    const inlineWrites = collectOrdinaryPropertyDefinitions(expression).map((definition) => ({
      ...definition,
      availableAt: position,
      position: definition.position,
      referenceRanges: definition.referenceNodes.map((reference) => ({
        end: reference.end,
        start: reference.getStart(sourceFile),
      })),
    }));
    return {
      inlineWrites,
      path: [],
      sourceKey: null,
    };
  };
  const pushRelation = ({ ownerKey, targetPath, sourceExpression, position }) => {
    if (!ownerKey) return;
    relations.push({
      ownerKey,
      position,
      sequence: sequence++,
      targetPath,
      ...relationSource(sourceExpression, position),
    });
  };
  const addCallRelations = (node, initializerOwnerKey = null) => {
    if (!ts.isCallExpression(node) || !node.arguments[1]) return;
    const method = memberAccess(node.expression);
    if (
      !method ||
      !ts.isIdentifier(method.receiver) ||
      method.receiver.text !== 'Object' ||
      !isUnshadowedGlobalValueReference(method.receiver) ||
      method.name !== 'setPrototypeOf'
    ) {
      return;
    }
    const position = node.getStart(sourceFile);
    if (initializerOwnerKey) {
      pushRelation({
        ownerKey: initializerOwnerKey,
        position,
        sourceExpression: node.arguments[1],
        targetPath: [],
      });
    }
    if (!node.arguments[0]) return;
    for (const target of bindingAliasTargets(node.arguments[0], position, bindingModel)) {
      pushRelation({
        ownerKey: target.sourceKey,
        position,
        sourceExpression: node.arguments[1],
        targetPath: target.path,
      });
    }
  };
  for (const [ownerKey, binding] of bindingModel.versions) {
    const initializer = unwrapExpression(binding.initializer);
    addCallRelations(initializer, ownerKey);
    if (!ts.isClassLike(initializer)) continue;
    const heritage = initializer.heritageClauses?.find(
      ({ token }) => token === ts.SyntaxKind.ExtendsKeyword
    );
    const baseExpression = heritage?.types[0]?.expression;
    if (!baseExpression) continue;
    const position = initializer.getStart(sourceFile);
    const base = bindingAliasTargets(baseExpression, position, bindingModel).at(-1);
    if (!base) continue;
    relations.push({
      ownerKey,
      path: [...base.path, 'prototype'],
      position,
      sequence: sequence++,
      sourceKey: base.sourceKey,
      targetPath: ['prototype'],
    });
  }
  visitDefiniteTopLevelExpressions(sourceFile, (node) => {
    addCallRelations(node);
  });
  return relations;
}
