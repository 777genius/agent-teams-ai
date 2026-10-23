import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Issue {
  code: string;
  path: unknown[];
  maximum?: number;
  message?: string;
  exact?: boolean;
}
interface Result {
  success: boolean;
  data?: unknown;
  error?: { issues: Issue[] };
}
interface Params {
  message?: string;
  when?: () => boolean;
}
interface Schema {
  max(n: number, params?: string | Params): Schema;
  min(n: number): Schema;
  length(n: number, params?: string): Schema;
  size(n: number, params?: string): Schema;
  refine(fn: () => boolean, params?: Params): Schema;
  superRefine(fn: () => void): Schema;
  transform(fn: (value: unknown) => unknown): Schema;
  overwrite(fn: (value: unknown) => unknown): Schema;
  check(...checks: unknown[]): Schema;
  safeParse(value: unknown): Result;
  safeParseAsync(value: unknown): Promise<Result>;
}
interface Zod {
  any(): Schema;
  string(): Schema;
  number(): Schema;
  array(element: Schema): Schema;
  set(element: Schema): Schema;
  map(key: Schema, value: Schema): Schema;
  object(shape: Record<string, Schema>): Schema;
  maxLength(n: number, params?: Params): unknown;
  maxSize(n: number, params?: Params): unknown;
  size(n: number): unknown;
  length(n: number): unknown;
  overwrite(fn: (value: unknown) => unknown): unknown;
  safeParse(schema: Schema, value: unknown): Result;
  safeParseAsync(schema: Schema, value: unknown): Promise<Result>;
}

/** Proves only leading bounded-container early rejection, not unbounded input protection. */
export async function verifyZodBehavior(packageRoot: string): Promise<void> {
  const require = createRequire(join(packageRoot, 'package.json'));
  // Exercise root/v3, classic v4 and mini; all public CJS/ESM container entrypoints.
  for (const [entry, v4, mini] of [
    ['', false, false],
    ['v3/', false, false],
    ['v4/', true, false],
    ['v4/mini/', true, true],
    ['v4-mini/', true, true],
  ] as const) {
    for (const extension of ['cjs', 'js']) {
      const file = join(packageRoot, entry, `index.${extension}`);
      const z = (
        extension === 'cjs' ? require(file) : await import(pathToFileURL(file).href)
      ) as Zod;
      const label = `${entry || 'root/'}index.${extension}`;
      let children = 0;
      let after = 0;
      const leaf = () =>
        mini
          ? z.any().check(() => {
              children++;
            })
          : z.any().superRefine(() => {
              children++;
            });
      const parse = (schema: Schema, value: unknown) =>
        mini ? z.safeParse(schema, value) : schema.safeParse(value);
      const parseAsync = (schema: Schema, value: unknown) =>
        mini ? z.safeParseAsync(schema, value) : schema.safeParseAsync(value);
      const arrayMax = (schema: Schema, limit: number, message?: string) =>
        mini
          ? schema.check(z.maxLength(limit, message ? { message } : undefined))
          : schema.max(limit, message);
      const setMax = (schema: Schema, limit: number) =>
        mini ? schema.check(z.maxSize(limit)) : schema.max(limit);
      const follow = (schema: Schema) =>
        mini
          ? schema.check(() => {
              after++;
            })
          : schema.refine(() => {
              after++;
              return true;
            });
      const checkOversized = async (schema: Schema, value: unknown, path: unknown[] = []) => {
        for (const async of [false, true]) {
          children = 0;
          after = 0;
          const result = async ? await parseAsync(schema, value) : parse(schema, value);
          assert.equal(result.success, false, label);
          assert.equal(children, 0, `${label}: rejected container must not parse children`);
          assert.equal(after, 0, `${label}: rejected container must not run following refinement`);
          assert.equal(result.error?.issues.length, 1, label);
          assert.equal(result.error?.issues[0].code, 'too_big', label);
          assert.deepEqual(result.error?.issues[0].path, path, label);
        }
      };
      await checkOversized(follow(arrayMax(z.array(leaf()), 1, 'bounded array')), [1, 2]);
      await checkOversized(follow(setMax(z.set(leaf()), 1)), new Set([1, 2]));
      if (!mini) {
        children = 0;
        const asyncLeaf = z.any().superRefine(async () => {
          children++;
        });
        const asyncBounded = arrayMax(z.array(asyncLeaf), 1);
        assert.equal(
          parse(asyncBounded, [1, 2]).success,
          false,
          `${label}: sync oversized input never starts async children`
        );
        assert.equal((await parseAsync(asyncBounded, [1, 2])).success, false, label);
        assert.equal(children, 0, label);
      }
      const exactArray = mini ? z.array(leaf()).check(z.length(1)) : z.array(leaf()).length(1);
      await checkOversized(follow(exactArray), [1, 2]);
      const exactSet = mini ? z.set(leaf()).check(z.size(1)) : z.set(leaf()).size(1);
      await checkOversized(follow(exactSet), new Set([1, 2]));
      const nested = z.object({ values: arrayMax(z.array(leaf()), 1) });
      await checkOversized(nested, { values: [1, 2] }, ['values']);
      const small = arrayMax(z.array(leaf()), 1, 'bounded array');
      assert.equal(parse(small, [1, 2]).error?.issues[0].message, 'bounded array', label);
      children = 0;
      assert.equal(parse(small, [1]).success, true, label);
      assert.equal(children, 1, label);
      assert.equal(parse(small, 'not an array').error?.issues[0].code, 'invalid_type', label);
      const below = mini ? z.array(z.number()).check(z.length(2)) : z.array(z.number()).length(2);
      assert.equal(parse(below, [1]).error?.issues[0].code, 'too_small', label);
      // Deliberately unbounded schemas still traverse: this is not an input-size firewall.
      children = 0;
      assert.equal(parse(z.array(leaf()), [1, 2]).success, true, label);
      assert.equal(children, 2, label);
      if (v4) {
        const map = z.map(leaf(), leaf()).check(z.maxSize(1));
        await checkOversized(
          follow(map),
          new Map([
            [1, 1],
            [2, 2],
          ])
        );
        await checkOversized(
          follow(z.map(leaf(), leaf()).check(z.size(1))),
          new Map([
            [1, 1],
            [2, 2],
          ])
        );
        assert.equal(parse(map, new Set([1, 2])).error?.issues[0].code, 'invalid_type', label);
        const trim = (value: unknown) => (value as unknown[]).slice(0, 1);
        const overwritten = mini
          ? z.array(z.number()).check(z.overwrite(trim))
          : z.array(z.number()).overwrite(trim);
        assert.deepEqual(
          parse(arrayMax(overwritten, 1), [1, 2]).data,
          [1],
          `${label}: overwrite precedes limit`
        );
        const disabled = mini
          ? z.array(leaf()).check(z.maxLength(1, { when: () => false }))
          : z.array(leaf()).max(1, { when: () => false });
        children = 0;
        assert.equal(
          parse(disabled, [1, 2]).success,
          true,
          `${label}: when:false must remain effective`
        );
        assert.equal(children, 2, label);
        // A non-size check is an ordering barrier, even when a later bound would reject.
        children = 0;
        const first = mini ? z.array(leaf()).check(() => {}) : z.array(leaf()).refine(() => true);
        assert.equal(parse(arrayMax(first, 1), [1, 2]).success, false, label);
        assert.equal(children, 2, `${label}: do not move a bound across a prior check`);
      }
    }
  }
}
