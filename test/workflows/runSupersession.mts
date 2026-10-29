// Canonical run-supersession concurrency for automatic check workflows, plus a
// minimal evaluator for the GitHub expression subset these policies use.
// Policy and rationale: docs/ci-qualification.md#run-supersession.
// Dependency-free so the early CI plan step can import it without installing.
/* eslint-disable sonarjs/function-return-type -- GitHub expression values are dynamically typed. */

// Only a push to a branch other than the default branch or release/* may be
// superseded. Default-branch, release and tag pushes keep per-commit evidence.
const SUPERSEDABLE_PUSH =
  "github.event_name == 'push' && github.ref_type == 'branch' && github.ref_name != github.event.repository.default_branch && !startsWith(github.ref_name, 'release/')";

// PRs share one group per PR number, merge queue entries and supersedable pushes
// one group per ref; every other run (default-branch push, schedule, dispatch)
// gets its own run ID. The event name keeps identities from different events apart.
export const SUPERSESSION_GROUP = `\${{ github.workflow }}-\${{ github.event_name }}-\${{ github.event_name == 'pull_request' && github.event.pull_request.number || (github.event_name == 'merge_group' || ${SUPERSEDABLE_PUSH}) && github.ref || github.run_id }}`;

export const SUPERSESSION_CANCEL = `\${{ github.event_name == 'pull_request' || ${SUPERSEDABLE_PUSH} }}`;

export type ExpressionValue = string | number | boolean | null | ExpressionObject;

export interface ExpressionObject {
  readonly [key: string]: ExpressionValue | undefined;
}

export type ExpressionContext = Readonly<Record<string, ExpressionValue | undefined>>;

interface Token {
  kind: 'string' | 'number' | 'name' | 'operator';
  text: string;
}

type Node =
  | { type: 'literal'; value: ExpressionValue }
  | { type: 'path'; root: string; keys: string[] }
  | { type: 'not'; operand: Node }
  | { type: 'binary'; operator: string; left: Node; right: Node }
  | { type: 'call'; name: string; args: Node[] };

const TOKEN_PATTERNS: readonly (readonly [Token['kind'], RegExp])[] = [
  ['string', /'(?:[^']|'')*'/y],
  ['number', /\d+/y],
  ['name', /[A-Za-z_][\w-]*/y],
  ['operator', /==|!=|&&|\|\||[!().,]/y],
];
const KEYWORDS = new Map<string, ExpressionValue>([
  ['true', true],
  ['false', false],
  ['null', null],
]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    if (/\s/.test(source.charAt(index))) {
      index++;
      continue;
    }
    const match = TOKEN_PATTERNS.map(([kind, pattern]) => {
      pattern.lastIndex = index;
      return { kind, match: pattern.exec(source) };
    }).find((candidate) => candidate.match);
    if (!match?.match) throw new Error(`Unsupported expression syntax: ${source.slice(index)}`);
    const text = match.match[0];
    tokens.push({
      kind: match.kind,
      text: match.kind === 'string' ? text.slice(1, -1).replaceAll("''", "'") : text,
    });
    index += text.length;
  }
  return tokens;
}

// Recursive descent; precedence from highest: !, == and !=, &&, ||.
class ExpressionParser {
  private readonly source: string;
  private readonly tokens: Token[];
  private position = 0;

  constructor(source: string) {
    this.source = source;
    this.tokens = tokenize(source);
  }

  parse(): Node {
    const tree = this.or();
    if (this.position !== this.tokens.length) throw this.error('Trailing tokens');
    return tree;
  }

  private error(message: string): Error {
    return new Error(`${message} in expression: ${this.source}`);
  }

  private at(operator: string): boolean {
    const token = this.tokens.at(this.position);
    return token?.kind === 'operator' && token.text === operator;
  }

  private next(): Token {
    const token = this.tokens.at(this.position++);
    if (!token) throw this.error('Unexpected end');
    return token;
  }

  private consume(operator: string): void {
    if (!this.at(operator)) throw this.error(`Expected '${operator}'`);
    this.position++;
  }

  private binary(operators: readonly string[], operand: () => Node): Node {
    let left = operand();
    while (operators.some((operator) => this.at(operator))) {
      const operator = this.next().text;
      left = { type: 'binary', operator, left, right: operand() };
    }
    return left;
  }

  private or(): Node {
    return this.binary(['||'], () => this.and());
  }

  private and(): Node {
    return this.binary(['&&'], () => this.equality());
  }

  private equality(): Node {
    return this.binary(['==', '!='], () => this.unary());
  }

  private unary(): Node {
    if (!this.at('!')) return this.primary();
    this.position++;
    return { type: 'not', operand: this.unary() };
  }

  private primary(): Node {
    const token = this.next();
    if (token.kind === 'string') return { type: 'literal', value: token.text };
    if (token.kind === 'number') return { type: 'literal', value: Number(token.text) };
    if (token.kind === 'operator') {
      if (token.text !== '(') throw this.error(`Unexpected '${token.text}'`);
      const inner = this.or();
      this.consume(')');
      return inner;
    }
    if (KEYWORDS.has(token.text)) return { type: 'literal', value: KEYWORDS.get(token.text)! };
    return this.at('(') ? this.call(token.text) : this.path(token.text);
  }

  private call(name: string): Node {
    this.consume('(');
    const args: Node[] = [];
    while (!this.at(')')) {
      if (args.length > 0) this.consume(',');
      args.push(this.or());
    }
    this.consume(')');
    return { type: 'call', name, args };
  }

  private path(root: string): Node {
    const keys: string[] = [];
    while (this.at('.')) {
      this.position++;
      const key = this.next();
      if (key.kind !== 'name') throw this.error('Unsupported property access');
      keys.push(key.text);
    }
    return { type: 'path', root, keys };
  }
}

function isObject(value: ExpressionValue | undefined): value is ExpressionObject {
  return typeof value === 'object' && value !== null;
}

function truthy(value: ExpressionValue): boolean {
  if (isObject(value)) return true;
  return value !== null && value !== false && value !== '' && value !== 0 && !Number.isNaN(value);
}

function toText(value: ExpressionValue): string {
  if (isObject(value)) throw new Error('Objects cannot be interpolated');
  return value === null ? '' : String(value);
}

function toNumber(value: ExpressionValue): number {
  if (isObject(value)) return Number.NaN;
  if (value === null) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return value.trim() === '' ? 0 : Number(value);
  return value;
}

// GitHub compares strings case-insensitively and coerces mismatched types to numbers.
function looselyEqual(left: ExpressionValue, right: ExpressionValue): boolean {
  if (typeof left === 'string' && typeof right === 'string') {
    return left.toLowerCase() === right.toLowerCase();
  }
  if (typeof left === typeof right) return left === right;
  return toNumber(left) === toNumber(right);
}

function lookup(
  context: ExpressionContext,
  root: string,
  keys: readonly string[]
): ExpressionValue {
  let value = new Map(Object.entries(context)).get(root);
  for (const key of keys)
    value = isObject(value) ? new Map(Object.entries(value)).get(key) : undefined;
  return value ?? null;
}

// Logical operators return an operand, as in GitHub expressions.
function evaluateBinary(
  node: Extract<Node, { type: 'binary' }>,
  context: ExpressionContext
): ExpressionValue {
  const left = evaluateNode(node.left, context);
  if (node.operator === '&&') return truthy(left) ? evaluateNode(node.right, context) : left;
  if (node.operator === '||') return truthy(left) ? left : evaluateNode(node.right, context);
  const equal = looselyEqual(left, evaluateNode(node.right, context));
  return node.operator === '==' ? equal : !equal;
}

function evaluateCall(
  node: Extract<Node, { type: 'call' }>,
  context: ExpressionContext
): ExpressionValue {
  const args = node.args.map((arg) => toText(evaluateNode(arg, context)));
  const name = node.name.toLowerCase();
  if (name === 'startswith' && args.length === 2) {
    return args[0].toLowerCase().startsWith(args[1].toLowerCase());
  }
  if (name === 'format' && args.length > 0) {
    return args[0].replace(/\{\{|\}\}|\{(\d+)\}/g, (match, index?: string) =>
      index === undefined ? match.charAt(0) : (args.at(Number(index) + 1) ?? '')
    );
  }
  throw new Error(`Unsupported expression function: ${node.name}`);
}

function evaluateNode(node: Node, context: ExpressionContext): ExpressionValue {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'path':
      return lookup(context, node.root, node.keys);
    case 'not':
      return !truthy(evaluateNode(node.operand, context));
    case 'binary':
      return evaluateBinary(node, context);
    case 'call':
      return evaluateCall(node, context);
  }
}

/**
 * Evaluates a workflow value the way the runner does: a value that is exactly one
 * `${{ }}` expression keeps its type, anything else interpolates into a string.
 */
export function evaluateWorkflowValue(value: unknown, context: ExpressionContext): ExpressionValue {
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'string') throw new Error(`Unsupported workflow value: ${String(value)}`);
  const parts = value.trim().split(/\$\{\{(.*?)\}\}/s);
  const evaluate = (source: string) => evaluateNode(new ExpressionParser(source).parse(), context);
  if (parts.length === 3 && parts[0] === '' && parts[2] === '') return evaluate(parts[1]);
  return parts.map((part, index) => (index % 2 === 0 ? part : toText(evaluate(part)))).join('');
}
