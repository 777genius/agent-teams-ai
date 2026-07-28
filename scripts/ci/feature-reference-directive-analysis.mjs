export function collectReferenceDirectiveEdges(sourceFile, sourcePath) {
  return [...sourceFile.typeReferenceDirectives, ...sourceFile.referencedFiles].map(
    (reference) => ({
      isTypeOnly: true,
      kind: 'reference',
      line: sourceFile.getLineAndCharacterOfPosition(reference.pos).line + 1,
      source: sourcePath,
      specifier: reference.fileName,
    })
  );
}
