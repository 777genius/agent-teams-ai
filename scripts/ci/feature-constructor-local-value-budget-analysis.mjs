import ts from 'typescript';

const MAX_EXACT_PATH_ASSIGNMENTS = 256;
const MAX_SHARED_ANALYSIS_STEPS = MAX_EXACT_PATH_ASSIGNMENTS ** 2;
const MAX_SOLVER_DEPTH = MAX_EXACT_PATH_ASSIGNMENTS * 2;

export const createConstructorLocalValueBudget = () => ({
  remaining: MAX_SHARED_ANALYSIS_STEPS,
});

export const constraintsMatch = (left, right) =>
  [...left].every(([control, selected]) => !right.has(control) || right.get(control) === selected);

function spend(budget) {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

function boundedControlAssignments(controls, initial) {
  let assignments = [new Map(initial)];
  for (const control of controls) {
    if (assignments.length > MAX_EXACT_PATH_ASSIGNMENTS / 2) return null;
    assignments = assignments.flatMap((choices) => [
      new Map(choices).set(control, false),
      new Map(choices).set(control, true),
    ]);
  }
  return assignments;
}

const entails = (choices, path) =>
  [...path].every(([control, selected]) => choices.get(control) === selected);

function exclusionWitness(paths, initial, budget) {
  const solve = (choices, depth) => {
    if (depth > MAX_SOLVER_DEPTH || !spend(budget)) return null;
    let shortest = null;
    for (const path of paths) {
      if (!spend(budget)) return null;
      if (
        [...path].some(
          ([control, selected]) => choices.has(control) && choices.get(control) !== selected
        )
      ) {
        continue;
      }
      const remaining = [...path].filter(([control]) => !choices.has(control));
      if (remaining.length === 0) return false;
      if (!shortest || remaining.length < shortest.length) {
        shortest = remaining.map(([control, selected]) => [control, !selected]);
      }
    }
    if (!shortest) return choices;
    let unknown = false;
    for (const [control, selected] of shortest) {
      const result = solve(new Map(choices).set(control, selected), depth + 1);
      if (result) return result;
      unknown ||= result === null;
    }
    return unknown ? null : false;
  };
  return solve(new Map(initial), 0);
}

function sequenceForWitness(candidates, choices, budget) {
  const sequence = [];
  for (const write of candidates) {
    if (!spend(budget)) return null;
    if (entails(choices, write.path.constraints)) sequence.push(write);
  }
  return sequence;
}

function failClosedSequence(write) {
  return write ? [{ ...write, operator: ts.SyntaxKind.EqualsToken }] : [];
}

function* writeSpecifications(candidates) {
  yield [];
  for (let terminal = candidates.length - 1; terminal >= 0; terminal -= 1) {
    yield [candidates[terminal]];
  }
  for (let terminal = candidates.length - 1; terminal >= 0; terminal -= 1) {
    for (let required = 0; required < terminal; required += 1) {
      yield [candidates[required], candidates[terminal]];
    }
  }
}

function* conservativeWriteSequences(candidates, initial, budget) {
  const controls = new Set(candidates.flatMap((write) => [...write.path.constraints.keys()]));
  const emitted = new Set();
  for (const selected of writeSpecifications(candidates)) {
    if (budget.remaining <= 0) {
      yield* failClosedWriteSequences(candidates);
      return;
    }
    const fixed = new Map(initial);
    let compatible = true;
    for (const write of selected) {
      for (const [control, choice] of write.path.constraints) {
        if (fixed.has(control) && fixed.get(control) !== choice) compatible = false;
        else fixed.set(control, choice);
      }
    }
    if (!compatible) continue;
    const selectedIndex =
      selected.length === 0 ? -1 : Math.max(...selected.map((write) => candidates.indexOf(write)));
    const witness = exclusionWitness(
      candidates.slice(selectedIndex + 1).map((write) => write.path.constraints),
      fixed,
      budget
    );
    if (witness === false) continue;
    if (witness === null) {
      yield* failClosedWriteSequences(candidates);
      return;
    }
    const completed = new Map([...controls].map((control) => [control, false]));
    for (const entry of witness) completed.set(...entry);
    const sequence = sequenceForWitness(candidates, completed, budget);
    if (!sequence) {
      yield* failClosedWriteSequences(candidates);
      return;
    }
    const key = sequence.map((write) => write.key).join('|');
    if (!emitted.has(key)) {
      emitted.add(key);
      yield sequence;
    }
  }
}

function failClosedWriteSequences(candidates) {
  return candidates.map(failClosedSequence);
}

export function budgetedWriteSequences(
  candidates,
  initial = new Map(),
  budget = createConstructorLocalValueBudget()
) {
  const controls = new Set(
    candidates
      .flatMap((write) => [...write.path.constraints.keys()])
      .filter((control) => !initial.has(control))
  );
  const assignments = boundedControlAssignments(controls, initial);
  if (!assignments) return conservativeWriteSequences(candidates, initial, budget);
  const sequences = [];
  for (const choices of assignments) {
    const sequence = [];
    for (const write of candidates) {
      if (!spend(budget)) {
        return [...sequences, ...failClosedWriteSequences(candidates)];
      }
      if (constraintsMatch(write.path.constraints, choices)) sequence.push(write);
    }
    sequences.push(sequence);
  }
  return [
    ...new Map(
      sequences.map((sequence) => [sequence.map(({ key }) => key).join('|'), sequence])
    ).values(),
  ];
}

export function simpleAssignmentTerminalWriteNodes(root, classifyAssignment) {
  const writes = [];
  let unsupported = false;
  const visit = (node) => {
    if (node !== root && (ts.isFunctionLike(node) || ts.isClassLike(node))) {
      unsupported = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      unsupported = true;
      return;
    }
    if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
      const write = classifyAssignment(node);
      if (write === false) {
        unsupported = true;
        return;
      }
      if (write) writes.push(write);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (unsupported) return null;
  const candidates = writes
    .filter((write) => write.path.reachable)
    .sort((left, right) => left.position - right.position);
  const terminal = new Set();
  const budget = createConstructorLocalValueBudget();
  for (const sequence of budgetedWriteSequences(candidates, new Map(), budget)) {
    if (sequence.length > 0) terminal.add(sequence.at(-1).node);
  }
  return terminal;
}
