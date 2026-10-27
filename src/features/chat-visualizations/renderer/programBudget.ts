import { autoClose, parseExpression, split, tokenize } from '@openuidev/lang-core';

import type { ASTNode } from '@openuidev/lang-core';

// Count expanded values before the SDK materializes every use of a named reference.
// Strings include their displayed length; components include a small DOM allowance.
const MAX_EXPANDED_UNITS = 50_000;
const OVER_BUDGET = MAX_EXPANDED_UNITS + 1;
const COMPONENT_UNITS = 16;

type BudgetStatus = 'within' | 'limit' | 'unavailable';

function cleanSource(source: string): string | null {
  // The SDK extracts embedded fences before removing comments, and only protects
  // double-quoted strings during that step. Nested wrappers are not our DSL.
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '"') {
      for (index++; index < source.length; index++) {
        if (source[index] === '\\') index++;
        else if (source[index] === '"') break;
      }
    } else if (source.startsWith('```', index)) return null;
  }

  let result = '';
  let quote: string | null = null;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      result += char;
      if (char === '\\' && index + 1 < source.length) result += source[++index];
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      result += char;
    } else if (char === '#' || (char === '/' && source[index + 1] === '/')) {
      while (index < source.length && source[index] !== '\n') index++;
      if (index < source.length) result += '\n';
    } else result += char;
  }
  return result;
}

/** Bound both materialized data and display work without expanding reference trees. */
export function checkChatVisualizationBudget(source: string): BudgetStatus {
  try {
    const cleaned = cleanSource(source);
    if (cleaned === null) return 'unavailable';
    const statements = split(tokenize(autoClose(cleaned).text));
    const definitions = new Map<string, ASTNode[]>();
    for (const statement of statements) {
      const variants = definitions.get(statement.id) ?? [];
      variants.push(parseExpression(statement.tokens));
      definitions.set(statement.id, variants);
    }

    const memo = new Map<string, number>();
    const active = new Set<string>();
    const add = (left: number, right: number): number => Math.min(OVER_BUDGET, left + right);
    const total = (nodes: ASTNode[], initial = 1): number => {
      let units = initial;
      for (const node of nodes) {
        units = add(units, cost(node));
        if (units > MAX_EXPANDED_UNITS) break;
      }
      return units;
    };
    const referenceCost = (name: string): number => {
      const cached = memo.get(name);
      if (cached !== undefined) return cached;
      if (active.has(name)) return OVER_BUDGET;
      const variants = definitions.get(name);
      if (!variants) return 1; // A forward reference can arrive in the next stream update.
      active.add(name);
      let units = 1;
      for (const node of variants) units = Math.max(units, cost(node));
      active.delete(name);
      memo.set(name, units);
      return units;
    };
    function cost(node: ASTNode): number {
      switch (node.k) {
        case 'Ref':
          return referenceCost(node.n);
        case 'Str':
          return Math.min(OVER_BUDGET, 1 + node.v.length);
        case 'Comp':
          return total(node.args, COMPONENT_UNITS);
        case 'Arr':
          return total(node.els);
        case 'Obj': {
          let units = 1;
          for (const [key, value] of node.entries) {
            units = add(units, add(key.length + 1, cost(value)));
            if (units > MAX_EXPANDED_UNITS) break;
          }
          return units;
        }
        case 'BinOp':
          return total([node.left, node.right]);
        case 'UnaryOp':
          return total([node.operand]);
        case 'Ternary':
          return total([node.cond, node.then, node.else]);
        case 'Member':
          return add(1 + node.field.length, cost(node.obj));
        case 'Index':
          return total([node.obj, node.index]);
        case 'Assign':
          return add(1 + node.target.length, cost(node.value));
        default:
          return 1;
      }
    }

    // Summing all definitions also bounds state initialization and fallback roots.
    // Taking the largest duplicate bounds both a completed statement retained by
    // the streaming parser and a later partial replacement of that statement.
    let units = 0;
    for (const name of definitions.keys()) {
      units = add(units, referenceCost(name));
      if (units > MAX_EXPANDED_UNITS) return 'limit';
    }
    return 'within';
  } catch {
    // Invalid or excessively deep ASTs must not reach the materializing parser.
    return 'unavailable';
  }
}
