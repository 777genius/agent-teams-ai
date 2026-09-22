import { comparePropertyWriteOrder } from './feature-public-object-analysis.mjs';

function writeKey(write) {
  return JSON.stringify([
    write.availableAt,
    write.availabilityOrder,
    write.end,
    write.enumerable,
    write.originSourceKeys ?? [],
    write.path,
    write.position,
    write.referenceRanges ?? [],
  ]);
}

export function materializeIdentityAliasWrites(propertyWrites, aliases) {
  const neighbors = new Map();
  for (const [left, right] of aliases) {
    const leftNeighbors = neighbors.get(left) ?? new Set();
    const rightNeighbors = neighbors.get(right) ?? new Set();
    leftNeighbors.add(right);
    rightNeighbors.add(left);
    neighbors.set(left, leftNeighbors);
    neighbors.set(right, rightNeighbors);
  }

  const visited = new Set();
  for (const start of neighbors.keys()) {
    if (visited.has(start)) continue;
    const component = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      for (const neighbor of neighbors.get(current) ?? []) {
        if (!component.has(neighbor)) {
          component.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    const merged = new Map(
      [...component].flatMap((key) =>
        (propertyWrites.get(key) ?? []).map((write) => [writeKey(write), write])
      )
    );
    const writes = [...merged.values()].sort(comparePropertyWriteOrder);
    for (const key of component) {
      if (writes.length > 0) propertyWrites.set(key, writes);
    }
  }
  return propertyWrites;
}
