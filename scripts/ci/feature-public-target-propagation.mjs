function appendUniquePath(pathsByKey, key, path) {
  const paths = pathsByKey.get(key) ?? [];
  if (
    paths.some(
      (candidate) =>
        candidate.length === path.length &&
        candidate.every((segment, index) => segment === path[index])
    )
  ) {
    return false;
  }
  paths.push(path);
  pathsByKey.set(key, paths);
  return true;
}

export function propagateIdentityOwners(initialOwners, edges) {
  const owners = new Map(initialOwners);
  const queue = [...owners.keys()];
  while (queue.length > 0) {
    const source = queue.shift();
    const owner = owners.get(source);
    if (!owner) continue;
    for (const target of edges.get(source) ?? []) {
      if (owners.has(target)) continue;
      owners.set(target, owner);
      queue.push(target);
    }
  }
  return owners;
}

export function propagateCommonJsTargetPaths(
  initialPaths,
  identityAliases,
  memberRelations
) {
  const pathsByKey = new Map(
    [...initialPaths].map(([key, paths]) => [
      key,
      paths.map((path) => [...path]),
    ])
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [left, right] of identityAliases) {
      for (const path of pathsByKey.get(left) ?? []) {
        changed = appendUniquePath(pathsByKey, right, [...path]) || changed;
      }
      for (const path of pathsByKey.get(right) ?? []) {
        changed = appendUniquePath(pathsByKey, left, [...path]) || changed;
      }
    }
    for (const relation of memberRelations) {
      if (relation.liveAttached !== true) continue;
      for (const path of pathsByKey.get(relation.sourceKey) ?? []) {
        changed =
          appendUniquePath(
            pathsByKey,
            relation.ownerKey,
            [...path, ...relation.path]
          ) || changed;
      }
    }
  }
  return pathsByKey;
}
