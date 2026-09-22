import ts from 'typescript';

function typeParameterMatches(parameter, name) {
  return ts.isIdentifier(parameter.name) && parameter.name.text === name;
}

function conditionalTypeInfersName(conditionalType, name) {
  let found = false;
  const visit = (node) => {
    if (found || ts.isConditionalTypeNode(node)) return;
    if (ts.isInferTypeNode(node) && typeParameterMatches(node.typeParameter, name)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(conditionalType.extendsType);
  return found;
}

export function isShadowedTypeReference(node, sourceFile) {
  let child = node;
  let current = node.parent;
  while (current && current !== sourceFile) {
    if (
      'typeParameters' in current &&
      current.typeParameters?.some((parameter) => typeParameterMatches(parameter, node.text))
    ) {
      return true;
    }
    if (
      ts.isMappedTypeNode(current) &&
      child !== current.typeParameter &&
      typeParameterMatches(current.typeParameter, node.text)
    ) {
      return true;
    }
    if (
      ts.isConditionalTypeNode(current) &&
      child === current.trueType &&
      conditionalTypeInfersName(current, node.text)
    ) {
      return true;
    }
    child = current;
    current = current.parent;
  }
  return false;
}
