import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

interface Ast {
  type: string;
  nodes?: Ast[];
  value?: string;
  parent?: Ast;
}
interface Braces {
  (input: string, options?: Record<string, unknown>): string[];
  parse(input: string, options?: Record<string, unknown>): Ast;
  compile(ast: Ast, options?: Record<string, unknown>): string;
  expand(ast: Ast | string, options?: Record<string, unknown>): string[];
  stringify(ast: Ast, options?: Record<string, unknown>): string;
}
type Headers = Record<string, string>;
interface Request {
  url: string;
  method: string;
  headers: Headers;
}
interface Response {
  status: number;
  headers: Headers;
}
interface Policy {
  now(): number;
  maxAge(): number;
  timeToLive(): number;
  useStaleWhileRevalidate(): boolean;
  satisfiesWithoutRevalidation(request: Request): boolean;
  evaluateRequest(request: Request): {
    response?: unknown;
    revalidation?: { synchronous: boolean };
  };
  revalidationHeaders(request: Request): Headers;
  revalidatedPolicy(
    request: Request,
    response?: Response | null
  ): { modified: boolean; matches: boolean; policy: Policy };
  toObject(): unknown;
}
interface PolicyConstructor {
  new (request: Request, response: Response, options?: { shared: boolean }): Policy;
  fromObject(value: unknown): Policy;
}

export function verifyBracesBehavior(packageRoot: string): void {
  const braces = createRequire(join(packageRoot, 'package.json'))(packageRoot) as Braces;
  const pattern = (depth: number) => '{'.repeat(depth) + 'a,b' + '}'.repeat(depth);
  const ast = (depth: number): Ast => {
    let node: Ast = { type: 'text', value: 'a' };
    for (let i = 0; i < depth; i++) node = { type: 'brace', nodes: [node] };
    return { type: 'root', nodes: [node] };
  };
  for (const depth of [1, 100]) assert.doesNotThrow(() => braces.parse(pattern(depth)));
  for (const options of [{}, { maxDepth: 1e6 }, { maxDepth: Infinity }, { maxDepth: NaN }]) {
    assert.throws(() => braces.parse(pattern(101), options), /exceeds max depth/);
    for (const method of [braces.compile, braces.expand, braces.stringify]) {
      assert.doesNotThrow(() => method(ast(100), options));
      assert.throws(() => method(ast(101), options), /exceeds max depth/);
    }
  }
  for (const maxDepth of [1, 1.5]) {
    assert.doesNotThrow(() => braces.parse(pattern(1), { maxDepth }));
    assert.throws(() => braces.parse(pattern(2), { maxDepth }), /exceeds max depth/);
    for (const method of [braces.compile, braces.expand, braces.stringify]) {
      assert.throws(() => method(ast(2), { maxDepth }), /exceeds max depth/);
    }
  }
  assert.throws(() => braces.parse('('.repeat(101) + 'a' + ')'.repeat(101)), /exceeds max depth/);
  assert.throws(() => braces.parse('{('.repeat(51) + 'a' + ')}'.repeat(51)), /exceeds max depth/);
  const parent: Ast = { type: 'paren', nodes: [] };
  parent.parent = parent;
  assert.throws(
    () => braces.expand({ type: 'root', nodes: [parent] }),
    /parent chain contains a cycle/
  );
  assert.deepEqual(braces.expand('x{a,b}{1..2}'), ['xa1', 'xa2', 'xb1', 'xb2']);
  assert.equal(braces.stringify(braces.parse('{a}'), { escapeInvalid: true }), '{a}');
  assert.equal(braces.compile(braces.parse('{a}'), { escapeInvalid: true }), '\\{a\\}');
  assert.deepEqual(braces('\\{a,b\\}'), ['{a,b}']);
}

export function verifyCacheBehavior(packageRoot: string): void {
  const CachePolicy = createRequire(join(packageRoot, 'package.json'))(
    packageRoot
  ) as PolicyConstructor;
  class SyntheticPolicy extends CachePolicy {
    now() {
      return 1700000000000;
    }
  }
  const request: Request = {
    url: '/synthetic',
    method: 'GET',
    headers: { host: 'example.test', accept: 'text/plain' },
  };
  const withHeaders = (headers: Headers): Request => ({
    ...request,
    headers: { ...request.headers, ...headers },
  });
  const extensions = 'max-age=60, stale-if-error=600, stale-while-revalidate=600';
  const policies = (headers: Headers = {}, shared = true, original = request): Policy[] => {
    const policy = new SyntheticPolicy(
      original,
      {
        status: 200,
        headers: { 'cache-control': extensions, age: '120', etag: '"synthetic-v1"', ...headers },
      },
      { shared }
    );
    const restored = CachePolicy.fromObject(JSON.parse(JSON.stringify(policy.toObject())));
    restored.now = () => 1700000000000;
    return [policy, restored];
  };
  const errors: (Response | null | undefined)[] = [500, 502, 503, 504].map((status) => ({
    status,
    headers: {},
  }));
  errors.push(null, undefined);
  const noFallback = (policy: Policy, next = request) => {
    for (const error of errors) {
      if (error == null)
        assert.throws(() => policy.revalidatedPolicy(next, error), /Response headers missing/);
      else assert.equal(policy.revalidatedPolicy(next, error).modified, true);
    }
  };
  const miss = (policy: Policy, next = request) => {
    assert.equal(policy.satisfiesWithoutRevalidation(next), false);
    assert.equal(policy.evaluateRequest(next).response, undefined);
    assert.equal(policy.evaluateRequest(next).revalidation?.synchronous, true);
  };
  const restricted = [
    { 'set-cookie': 'session=synthetic' },
    ...['private', 'no-store', 'no-cache', 'proxy-revalidate'].map((directive) => ({
      'cache-control': `${extensions}, ${directive}`,
    })),
    ...['*', ' * ', 'accept, *'].map((vary) => ({ vary })),
  ] as Headers[];
  for (const headers of restricted)
    for (const policy of policies(headers)) {
      assert.equal(policy.maxAge(), 0);
      assert.equal(policy.timeToLive(), 0);
      assert.equal(policy.useStaleWhileRevalidate(), false);
      for (const next of [
        request,
        withHeaders({ 'cache-control': 'max-stale' }),
        withHeaders({ 'cache-control': 'max-stale=86400' }),
      ])
        miss(policy, next);
      noFallback(policy);
    }
  for (const policy of policies({}, true, withHeaders({ authorization: 'synthetic-test-only' }))) {
    miss(
      policy,
      withHeaders({ authorization: 'synthetic-test-only', 'cache-control': 'max-stale' })
    );
    assert.equal(policy.timeToLive(), 0);
    assert.equal(policy.useStaleWhileRevalidate(), false);
    noFallback(policy, withHeaders({ authorization: 'synthetic-test-only' }));
  }
  for (const directive of ['must-revalidate', 's-maxage=60'])
    for (const age of ['30', '120']) {
      for (const policy of policies({ 'cache-control': `${extensions}, ${directive}`, age })) {
        assert.equal(policy.satisfiesWithoutRevalidation(request), age === '30');
        assert.equal(policy.timeToLive(), age === '30' ? 30000 : 0);
        if (age === '120') {
          miss(policy, withHeaders({ 'cache-control': 'max-stale' }));
          noFallback(policy);
        }
      }
    }
  const mismatches = [
    { ...request, url: '/other' },
    { ...request, method: 'POST' },
    withHeaders({ host: 'other.test' }),
    withHeaders({ accept: 'text/html' }),
    withHeaders({ 'cache-control': 'no-cache' }),
    withHeaders({ pragma: 'no-cache' }),
  ];
  for (const policy of policies({ vary: 'accept' }))
    for (const next of mismatches) {
      miss(policy, next);
      noFallback(policy, next);
    }
  for (const [headers, shared] of [
    [{ 'set-cookie': 'synthetic', 'cache-control': `${extensions}, public` }, true],
    [{ 'set-cookie': 'synthetic', 'cache-control': `${extensions}, immutable` }, true],
    [
      {
        'set-cookie': 'synthetic',
        'cache-control': `${extensions}, private, proxy-revalidate, s-maxage=60`,
      },
      false,
    ],
  ] as [Headers, boolean][])
    for (const policy of policies(headers, shared)) {
      assert.equal(policy.useStaleWhileRevalidate(), true);
      assert.equal(policy.timeToLive(), 540000);
      assert.equal(
        policy.satisfiesWithoutRevalidation(withHeaders({ 'cache-control': 'max-stale' })),
        true
      );
      assert.equal(policy.revalidatedPolicy(request, null).modified, false);
    }
  for (const policy of policies({ vary: 'accept' })) {
    const next = withHeaders({ 'cache-control': 'max-stale', pragma: 'no-cache' });
    assert.equal(policy.satisfiesWithoutRevalidation(next), true);
    for (const method of ['GET', 'HEAD']) {
      const conditional = {
        ...request,
        method,
        headers: policy.revalidationHeaders({ ...request, method }),
      };
      const validated = policy.revalidatedPolicy(conditional, {
        status: 304,
        headers: { etag: '"synthetic-v1"', age: '0' },
      });
      assert.equal(validated.matches, true);
      assert.equal(validated.modified, false);
    }
  }
}
