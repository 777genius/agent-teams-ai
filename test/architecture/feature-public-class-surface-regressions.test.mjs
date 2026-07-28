import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import ts from 'typescript';

import {
  FEATURE_ARCHITECTURE_RULES,
  collectFeatureArchitectureViolations,
} from '../../scripts/ci/feature-architecture-policy.mjs';
import { publicStaticClassSelection } from '../../scripts/ci/feature-public-class-analysis.mjs';
import { withFeatureFixture } from './support/feature-fixture.mjs';

function implementationViolationSources(root) {
  return collectFeatureArchitectureViolations(root)
    .violations.filter(
      ({ rule }) => rule === FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport
    )
    .map(({ source }) => source)
    .sort();
}

function infrastructureSource(name = 'Store') {
  return `export class ${name} {}`;
}

function directPublicStaticSelection(source) {
  const sourceFile = ts.createSourceFile(
    'direct-public-static-selection.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  let boundary = null;
  let reference = null;
  const visit = (node) => {
    if (ts.isClassDeclaration(node)) boundary = node;
    if (
      ts.isIdentifier(node) &&
      node.text === 'Store' &&
      ts.isBinaryExpression(node.parent) &&
      node.parent.right === node
    ) {
      reference = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(boundary);
  assert.ok(reference);
  return publicStaticClassSelection(reference, boundary);
}

test('traces anonymous, expression, instance, and static public class members', () => {
  withFeatureFixture(
    {
      'src/features/class-anonymous-default/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export default class {
          get store() {
            return Store;
          }
        }
      `,
      'src/features/class-anonymous-default/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-expression/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export const Api = class {
          get store() {
            return Store;
          }
        };
      `,
      'src/features/class-expression/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-static/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static get store() {
            return Store;
          }
        }
      `,
      'src/features/class-static/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-private-protected-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          private get privateStore() {
            return Store;
          }
          protected static get protectedStore() {
            return Store;
          }
        }
      `,
      'src/features/class-private-protected-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-anonymous-default/main/index.ts',
        'src/features/class-expression/main/index.ts',
        'src/features/class-static/main/index.ts',
      ]);
    }
  );
});

test('isolates local classes nested in public static blocks', () => {
  withFeatureFixture(
    {
      'src/features/class-static-block-local-class-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            class Inner {
              static {
                this.Store = Store;
              }
            }
            void Inner;
          }
        }
      `,
      'src/features/class-static-block-local-class-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-local-class-shadowed-sibling-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            class Inner {
              static {
                this.Store = Store;
              }
            }
            {
              class Inner {}
              this.Inner = Inner;
            }
            void Inner;
          }
        }
      `,
      'src/features/class-static-block-local-class-shadowed-sibling-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-assigned-class/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            class Inner {
              static {
                this.Store = Store;
              }
            }
            this.Inner = Inner;
          }
        }
      `,
      'src/features/class-static-block-assigned-class/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-direct-nested-class/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            this.Inner = class {
              static {
                this.Store = Store;
              }
            };
          }
        }
      `,
      'src/features/class-static-block-direct-nested-class/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-stale-assigned-class-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            class Inner {
              static {
                this.Store = Store;
              }
            }
            Inner = class {};
            this.Inner = Inner;
          }
        }
      `,
      'src/features/class-static-block-stale-assigned-class-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-ordinary-public-class/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static Store = Store;
        }
      `,
      'src/features/class-static-block-ordinary-public-class/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-assigned-class/main/index.ts',
        'src/features/class-static-block-direct-nested-class/main/index.ts',
        'src/features/class-static-block-ordinary-public-class/main/index.ts',
      ]);
    }
  );
});

test('models static-block terminal writes, aliases, branches, and returned values', () => {
  withFeatureFixture(
    {
      'src/features/class-static-block-assign-alias-call/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const assign = Object.assign;
            assign.call(null, this, { Store });
          }
        }
      `,
      'src/features/class-static-block-assign-alias-call/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-reflect-alias-apply/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const set = Reflect.set;
            set.apply(null, [this, 'Store', Store]);
          }
        }
      `,
      'src/features/class-static-block-reflect-alias-apply/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-branch-terminal-source/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const condition: boolean;
        export class Api {
          static {
            const fields: Record<string, unknown> = {};
            if (condition) fields.Store = Store;
            else fields.Store = undefined;
            Object.assign(this, fields);
          }
        }
      `,
      'src/features/class-static-block-branch-terminal-source/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-mutable-descriptor/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const descriptor: PropertyDescriptor = {};
            descriptor.value = Store;
            Object.defineProperty(this, 'Store', descriptor);
          }
        }
      `,
      'src/features/class-static-block-mutable-descriptor/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-alias-call/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            install.call(this);
          }
        }
      `,
      'src/features/class-static-block-function-alias-call/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-terminal-direct-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            this.Store = Store;
            this.Store = undefined;
          }
        }
      `,
      'src/features/class-static-block-terminal-direct-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-terminal-source-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const fields = { Store };
            fields.Store = undefined;
            Object.assign(this, fields);
          }
        }
      `,
      'src/features/class-static-block-terminal-source-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-unreachable-source-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const fields: Record<string, unknown> = {};
            if (false) fields.Store = Store;
            Object.assign(this, fields);
          }
        }
      `,
      'src/features/class-static-block-unreachable-source-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-static-alias-overwrite-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            let assign = Object.assign;
            if (true) assign = () => undefined;
            assign(this, { Store });
          }
        }
      `,
      'src/features/class-static-block-static-alias-overwrite-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-shadowed-alias-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const { assign } = Object;
            {
              const assign = () => undefined;
              assign(this, { Store });
            }
          }
        }
      `,
      'src/features/class-static-block-shadowed-alias-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-static-apply-selection-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            Object.assign.apply(null, true ? [this, {}] : [this, { Store }]);
          }
        }
      `,
      'src/features/class-static-block-static-apply-selection-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-terminal-descriptor-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const descriptor = { value: Store };
            descriptor.value = undefined;
            Object.defineProperty(this, 'Store', descriptor);
          }
        }
      `,
      'src/features/class-static-block-terminal-descriptor-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-iife-return-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            this.Store = (() => {
              void Store;
              return undefined;
            })();
          }
        }
      `,
      'src/features/class-static-block-iife-return-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-assign-alias-call/main/index.ts',
        'src/features/class-static-block-branch-terminal-source/main/index.ts',
        'src/features/class-static-block-function-alias-call/main/index.ts',
        'src/features/class-static-block-mutable-descriptor/main/index.ts',
        'src/features/class-static-block-reflect-alias-apply/main/index.ts',
      ]);
    }
  );
});

test('bounds static-block terminal analysis across independent unknown controls', () => {
  const conditionalSafeOverwrites = Array.from(
    { length: 23 },
    (_, index) => `if (controls[${index + 1}]) fields.Store = undefined;`
  ).join('\n');
  const conditionalSafeRebinds = Array.from(
    { length: 23 },
    (_, index) => `if (controls[${index + 1}]) fields = { Store: undefined };`
  ).join('\n');
  const staticBlockSource = (terminalSafe) => `
    import { Store } from './infrastructure/Store';
    declare const controls: readonly boolean[];
    export class Api {
      static {
        const fields: Record<string, unknown> = {};
        if (controls[0]) fields.Store = Store;
        ${conditionalSafeOverwrites}
        ${terminalSafe ? 'fields.Store = undefined;' : ''}
        Object.assign(this, fields);
      }
    }
  `;
  const localValueSource = (dangerous) => `
    import { Store } from './infrastructure/Store';
    declare const controls: readonly boolean[];
    export class Api {
      static {
        let fields: Record<string, unknown> = {};
        if (controls[0]) fields = { Store: ${dangerous ? 'Store' : 'undefined'} };
        ${conditionalSafeRebinds}
        ${dangerous ? '' : 'void Store;'}
        Object.assign(this, fields);
      }
    }
  `;
  const logicalLocalValueSource = (terminalSafe) => `
    import { Store } from './infrastructure/Store';
    declare const controls: readonly boolean[];
    export class Api {
      static {
        let fields: Record<string, unknown> = {};
        if (controls[0]) fields = undefined;
        ${conditionalSafeRebinds}
        if (controls[24]) fields ??= { Store };
        ${terminalSafe ? 'fields = { Store: undefined };' : ''}
        Object.assign(this, fields);
      }
    }
  `;

  withFeatureFixture(
    {
      'src/features/class-static-block-control-stress-dangerous/main/index.ts':
        staticBlockSource(false),
      'src/features/class-static-block-control-stress-dangerous/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-control-stress-safe/main/index.ts': staticBlockSource(true),
      'src/features/class-static-block-control-stress-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-local-value-control-stress-dangerous/main/index.ts':
        localValueSource(true),
      'src/features/class-static-block-local-value-control-stress-dangerous/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-local-value-control-stress-safe/main/index.ts':
        localValueSource(false),
      'src/features/class-static-block-local-value-control-stress-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-logical-control-stress-dangerous/main/index.ts':
        logicalLocalValueSource(false),
      'src/features/class-static-block-logical-control-stress-dangerous/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-logical-control-stress-safe/main/index.ts':
        logicalLocalValueSource(true),
      'src/features/class-static-block-logical-control-stress-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-control-stress-dangerous/main/index.ts',
        'src/features/class-static-block-local-value-control-stress-dangerous/main/index.ts',
        'src/features/class-static-block-logical-control-stress-dangerous/main/index.ts',
      ]);
    }
  );
});

test('keeps same-branch terminal overwrites correlated after unrelated-control overflow', () => {
  const unrelatedWrites = Array.from(
    { length: 23 },
    (_, index) => `if (controls[${index + 1}]) this.other${index} = undefined;`
  ).join('\n');
  withFeatureFixture(
    {
      'src/features/class-static-block-correlated-overflow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const controls: readonly boolean[];
        export class Api {
          static {
            if (controls[0]) {
              this.Store = Store;
              this.Store = undefined;
            }
            ${unrelatedWrites}
          }
        }
      `,
      'src/features/class-static-block-correlated-overflow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), []);
    }
  );
});

test('honors a definite terminal safe rebind after local reaching-write overflow', () => {
  const unrelatedRebinds = Array.from(
    { length: 23 },
    (_, index) => `if (controls[${index + 1}]) fields = { Store: undefined };`
  ).join('\n');
  withFeatureFixture(
    {
      'src/features/class-static-block-terminal-rebind-overflow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const controls: readonly boolean[];
        export class Api {
          static {
            let fields: Record<string, unknown> = {};
            if (controls[0]) fields = { Store };
            ${unrelatedRebinds}
            fields = { Store: undefined };
            Object.assign(this, fields);
          }
        }
      `,
      'src/features/class-static-block-terminal-rebind-overflow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-exhaustive-rebind-overflow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const controls: readonly boolean[];
        export class Api {
          static {
            let fields: Record<string, unknown> = { Store };
            if (controls[0]) fields = { Store: undefined };
            else fields = { Store: undefined };
            ${unrelatedRebinds}
            Object.assign(this, fields);
          }
        }
      `,
      'src/features/class-static-block-exhaustive-rebind-overflow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), []);
    }
  );
});

test('models every reachable repeated local function invocation and receiver', () => {
  withFeatureFixture(
    {
      'src/features/class-static-block-call-after-wrong-receiver/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            install.call({});
            install.call(this);
          }
        }
      `,
      'src/features/class-static-block-call-after-wrong-receiver/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-call-after-unreachable/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            if (false) install.call(this);
            install.call(this);
          }
        }
      `,
      'src/features/class-static-block-call-after-unreachable/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-repeated-startup-operation/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const operation = function () {
              this.Store = Store;
            };
            const startup = function () {
              operation.call(this);
            };
            startup.call({});
            startup.call(this);
          }
        }
      `,
      'src/features/class-static-block-repeated-startup-operation/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-call-after-unreachable/main/index.ts',
        'src/features/class-static-block-call-after-wrong-receiver/main/index.ts',
        'src/features/class-static-block-repeated-startup-operation/main/index.ts',
      ]);
    }
  );
});

test('ignores class value writes after definite abrupt completion', () => {
  withFeatureFixture(
    {
      'src/features/class-static-block-iife-return-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            (() => {
              return;
              this.Store = Store;
            })();
          }
        }
      `,
      'src/features/class-static-block-iife-return-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-local-return-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              if (true) return;
              this.Store = Store;
            };
            install.call(this);
          }
        }
      `,
      'src/features/class-static-block-local-return-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-iife-throw-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            (() => {
              throw new Error('stop');
              this.Store = Store;
            })();
          }
        }
      `,
      'src/features/class-static-block-iife-throw-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), []);
    }
  );
});

test('preserves combination witnesses and nested exhaustive overwrites after path overflow', () => {
  const unrelatedDirect = Array.from(
    { length: 22 },
    (_, index) => `if (controls[${index + 2}]) this.other${index} = undefined;`
  ).join('\n');
  const unrelatedLocal = Array.from(
    { length: 22 },
    (_, index) => `if (controls[${index + 2}]) fields = { Store: undefined };`
  ).join('\n');
  const nestedDirect = Array.from(
    { length: 21 },
    (_, index) => `if (controls[${index + 3}]) this.other${index} = undefined;`
  ).join('\n');
  const nestedLocal = Array.from(
    { length: 21 },
    (_, index) => `if (controls[${index + 3}]) fields = { Store: undefined };`
  ).join('\n');
  withFeatureFixture(
    {
      'src/features/class-static-block-combination-overflow-dangerous/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const controls: readonly boolean[];
        export class Api {
          static {
            if (controls[0]) this.Store = Store;
            if (controls[1]) {}
            else this.Store = undefined;
            ${unrelatedDirect}
          }
        }
      `,
      'src/features/class-static-block-combination-overflow-dangerous/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-local-combination-overflow-dangerous/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const controls: readonly boolean[];
        export class Api {
          static {
            let fields: Record<string, unknown> = {};
            if (controls[0]) fields = { Store };
            if (controls[1]) {}
            else fields = { Store: undefined };
            ${unrelatedLocal}
            Object.assign(this, fields);
          }
        }
      `,
      'src/features/class-static-block-local-combination-overflow-dangerous/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-nested-exhaustive-overflow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const controls: readonly boolean[];
        export class Api {
          static {
            this.Store = Store;
            if (controls[0]) {
              if (controls[1]) this.Store = undefined;
              else this.Store = undefined;
            } else {
              if (controls[2]) this.Store = undefined;
              else this.Store = undefined;
            }
            ${nestedDirect}
          }
        }
      `,
      'src/features/class-static-block-nested-exhaustive-overflow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-local-nested-exhaustive-overflow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const controls: readonly boolean[];
        export class Api {
          static {
            let fields: Record<string, unknown> = { Store };
            if (controls[0]) {
              if (controls[1]) fields = { Store: undefined };
              else fields = { Store: undefined };
            } else {
              if (controls[2]) fields = { Store: undefined };
              else fields = { Store: undefined };
            }
            ${nestedLocal}
            Object.assign(this, fields);
          }
        }
      `,
      'src/features/class-static-block-local-nested-exhaustive-overflow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-combination-overflow-dangerous/main/index.ts',
        'src/features/class-static-block-local-combination-overflow-dangerous/main/index.ts',
      ]);
    }
  );
});

test('preserves receiver, ordering, and all-false paths beyond the local-call context bound', () => {
  const wrongCalls = Array.from({ length: 256 }, () => 'install.call({});').join('\n');
  const conditionalCalls = Array.from(
    { length: 257 },
    (_, index) => `if (controls[${index}]) install.call(this);`
  ).join('\n');
  withFeatureFixture(
    {
      'src/features/class-static-block-context-overflow-dangerous/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = undefined;
            };
            install.call(this);
            this.Store = Store;
            ${wrongCalls}
          }
        }
      `,
      'src/features/class-static-block-context-overflow-dangerous/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-context-overflow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            install.call(this);
            this.Store = undefined;
            ${wrongCalls}
          }
        }
      `,
      'src/features/class-static-block-context-path-overflow-dangerous/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const controls: readonly boolean[];
        export class Api {
          static {
            const install = function () {
              this.Store = undefined;
            };
            this.Store = Store;
            ${conditionalCalls}
          }
        }
      `,
      'src/features/class-static-block-context-path-overflow-dangerous/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-context-overflow-dangerous/main/index.ts',
        'src/features/class-static-block-context-path-overflow-dangerous/main/index.ts',
      ]);
    }
  );
});

test('bounds per-member terminal analysis across 257 unrelated writes and controls', () => {
  const nestedDanger = `${Array.from({ length: 9 }, (_, index) => `if (controls[${index}]) {`).join(
    ''
  )} this.Store = Store; ${'}'.repeat(9)}`;
  const middleWrites = Array.from({ length: 257 }, (_, index) => {
    if (index === 127) return nestedDanger;
    return index < 9
      ? `if (controls[${index}]) this.other = undefined;`
      : 'this.other = undefined;';
  }).join('\n');
  const independentWrites = Array.from({ length: 257 }, (_, index) =>
    index === 127
      ? `if (controls[${index}]) this.Store = Store;`
      : `if (controls[${index}]) this.other${index} = undefined;`
  ).join('\n');
  const started = performance.now();
  let elapsedMs = 0;
  withFeatureFixture(
    {
      'src/features/class-static-block-middle-member-overflow-dangerous/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const controls: readonly boolean[];
        export class Api {
          static {
            this.Store = undefined;
            ${middleWrites}
          }
        }
      `,
      'src/features/class-static-block-middle-member-overflow-dangerous/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-independent-control-runtime/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const controls: readonly boolean[];
        export class Api {
          static {
            this.Store = undefined;
            ${independentWrites}
          }
        }
      `,
      'src/features/class-static-block-independent-control-runtime/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-independent-control-runtime/main/index.ts',
        'src/features/class-static-block-middle-member-overflow-dangerous/main/index.ts',
      ]);
      elapsedMs = performance.now() - started;
    }
  );
  assert.ok(elapsedMs < 20_000, `257-control analysis took ${Math.round(elapsedMs)}ms`);
});

test('preserves every same-member terminal candidate under the shared path budget', () => {
  const writes = Array.from(
    { length: 257 },
    (_, index) => `if (controls[${index}]) this.Store = ${index === 127 ? 'Store' : 'undefined'};`
  ).join('\n');
  const source = `
    declare const Store: unknown;
    declare const controls: readonly boolean[];
    export class Api {
      static {
        ${writes}
      }
    }
  `;
  const directStarted = performance.now();
  assert.deepEqual(directPublicStaticSelection(source), {
    getterOnly: false,
    localMember: 'Store',
  });
  const directElapsedMs = performance.now() - directStarted;
  assert.ok(
    directElapsedMs < 20_000,
    `direct 257 same-member analysis took ${Math.round(directElapsedMs)}ms`
  );

  const collectorStarted = performance.now();
  let collectorElapsedMs = 0;
  withFeatureFixture(
    {
      'src/features/class-static-block-same-member-budget-dangerous/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const controls: readonly boolean[];
        export class Api {
          static {
            ${writes}
          }
        }
      `,
      'src/features/class-static-block-same-member-budget-dangerous/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-same-member-budget-terminal-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const controls: readonly boolean[];
        export class Api {
          static {
            ${writes}
            this.Store = undefined;
          }
        }
      `,
      'src/features/class-static-block-same-member-budget-terminal-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-same-member-budget-dangerous/main/index.ts',
      ]);
      collectorElapsedMs = performance.now() - collectorStarted;
    }
  );
  assert.ok(
    collectorElapsedMs < 20_000,
    `collector 257 same-member analysis took ${Math.round(collectorElapsedMs)}ms`
  );
});

test('orders lexical arrow writes by invocation while preserving ordinary receivers', () => {
  const arrowAfterSafe = `
    declare const Store: unknown;
    export class Api {
      static {
        const install = () => {
          this.Store = Store;
        };
        this.Store = undefined;
        install();
      }
    }
  `;
  const arrowBeforeSafe = `
    declare const Store: unknown;
    export class Api {
      static {
        const install = () => {
          this.Store = Store;
        };
        install();
        this.Store = undefined;
      }
    }
  `;
  const ordinaryDirectCall = `
    declare const Store: unknown;
    export class Api {
      static {
        const install = function () {
          this.Store = Store;
        };
        this.Store = undefined;
        install();
      }
    }
  `;
  const ordinaryStaticReceiver = `
    declare const Store: unknown;
    export class Api {
      static {
        const install = function () {
          this.Store = Store;
        };
        this.Store = undefined;
        install.call(this);
      }
    }
  `;
  assert.deepEqual(directPublicStaticSelection(arrowAfterSafe), {
    getterOnly: false,
    localMember: 'Store',
  });
  assert.equal(directPublicStaticSelection(arrowBeforeSafe), null);
  assert.equal(directPublicStaticSelection(ordinaryDirectCall), null);
  assert.deepEqual(directPublicStaticSelection(ordinaryStaticReceiver), {
    getterOnly: false,
    localMember: 'Store',
  });

  withFeatureFixture(
    {
      'src/features/class-static-block-arrow-after-safe-dangerous/main/index.ts':
        arrowAfterSafe.replace(
          'declare const Store: unknown;',
          "import { Store } from './infrastructure/Store';"
        ),
      'src/features/class-static-block-arrow-after-safe-dangerous/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-arrow-before-safe/main/index.ts': arrowBeforeSafe.replace(
        'declare const Store: unknown;',
        "import { Store } from './infrastructure/Store';"
      ),
      'src/features/class-static-block-arrow-before-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-ordinary-direct-call/main/index.ts':
        ordinaryDirectCall.replace(
          'declare const Store: unknown;',
          "import { Store } from './infrastructure/Store';"
        ),
      'src/features/class-static-block-ordinary-direct-call/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-ordinary-static-receiver-dangerous/main/index.ts':
        ordinaryStaticReceiver.replace(
          'declare const Store: unknown;',
          "import { Store } from './infrastructure/Store';"
        ),
      'src/features/class-static-block-ordinary-static-receiver-dangerous/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-arrow-after-safe-dangerous/main/index.ts',
        'src/features/class-static-block-ordinary-static-receiver-dangerous/main/index.ts',
      ]);
    }
  );
});

test('models retained values for direct logical static assignments', () => {
  withFeatureFixture(
    {
      'src/features/class-static-block-logical-or-retains-dangerous/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            this.Store = Store;
            this.Store ||= undefined;
          }
        }
      `,
      'src/features/class-static-block-logical-or-retains-dangerous/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-logical-nullish-retains-dangerous/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            this.Store = Store;
            this.Store ??= undefined;
          }
        }
      `,
      'src/features/class-static-block-logical-nullish-retains-dangerous/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-logical-and-retains-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            this.Store = undefined;
            this.Store &&= Store;
          }
        }
      `,
      'src/features/class-static-block-logical-and-retains-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-logical-object-or-overwrite-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            this.Store = {};
            this.Store ||= Store;
          }
        }
      `,
      'src/features/class-static-block-logical-object-or-overwrite-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-logical-object-nullish-overwrite-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            this.Store = {};
            this.Store ??= Store;
          }
        }
      `,
      'src/features/class-static-block-logical-object-nullish-overwrite-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-logical-and-reassigns-dangerous/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            this.Store = Store;
            this.Store &&= Store;
          }
        }
      `,
      'src/features/class-static-block-logical-and-reassigns-dangerous/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-logical-and-reassigns-dangerous/main/index.ts',
        'src/features/class-static-block-logical-nullish-retains-dangerous/main/index.ts',
        'src/features/class-static-block-logical-or-retains-dangerous/main/index.ts',
      ]);
    }
  );
});

test('resolves aliases of local functions call and apply methods', () => {
  withFeatureFixture(
    {
      'src/features/class-static-block-function-call-method-alias/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.call;
            invoke.call(install, this);
          }
        }
      `,
      'src/features/class-static-block-function-call-method-alias/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-apply-method-alias/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.apply;
            invoke.call(install, this, []);
          }
        }
      `,
      'src/features/class-static-block-function-apply-method-alias/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-call-method-alias-apply/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.call;
            invoke.apply(install, [this]);
          }
        }
      `,
      'src/features/class-static-block-function-call-method-alias-apply/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-call-method-alias-reflect/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.call;
            Reflect.apply(invoke, install, [this]);
          }
        }
      `,
      'src/features/class-static-block-function-call-method-alias-reflect/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-call-method-bound/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.call.bind(install);
            invoke(this);
          }
        }
      `,
      'src/features/class-static-block-function-call-method-bound/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-apply-method-alias-apply/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.apply;
            invoke.apply(install, [this, []]);
          }
        }
      `,
      'src/features/class-static-block-function-apply-method-alias-apply/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-call-method-alias-wrong-receiver-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.call;
            invoke.apply(install, [{}]);
          }
        }
      `,
      'src/features/class-static-block-function-call-method-alias-wrong-receiver-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-call-method-bound-wrong-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const other = function () {};
            const invoke = install.call.bind(other);
            invoke(this);
          }
        }
      `,
      'src/features/class-static-block-function-call-method-bound-wrong-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-function-apply-method-alias-apply/main/index.ts',
        'src/features/class-static-block-function-apply-method-alias/main/index.ts',
        'src/features/class-static-block-function-call-method-alias-apply/main/index.ts',
        'src/features/class-static-block-function-call-method-alias-reflect/main/index.ts',
        'src/features/class-static-block-function-call-method-alias/main/index.ts',
        'src/features/class-static-block-function-call-method-bound/main/index.ts',
      ]);
    }
  );
});

test('resolves call and apply receivers pre-bound through detached aliases', () => {
  withFeatureFixture(
    {
      'src/features/class-static-block-function-call-prebound-receiver/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.call.bind(install, this);
            invoke();
          }
        }
      `,
      'src/features/class-static-block-function-call-prebound-receiver/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-apply-prebound-receiver/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.apply.bind(install, this, []);
            invoke();
          }
        }
      `,
      'src/features/class-static-block-function-apply-prebound-receiver/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-call-prebound-wrong-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.call.bind(install, {});
            invoke(this);
          }
        }
      `,
      'src/features/class-static-block-function-call-prebound-wrong-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-apply-prebound-wrong-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.apply.bind(install, {}, []);
            invoke();
          }
        }
      `,
      'src/features/class-static-block-function-apply-prebound-wrong-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-function-apply-prebound-receiver/main/index.ts',
        'src/features/class-static-block-function-call-prebound-receiver/main/index.ts',
      ]);
    }
  );
});

test('traces direct class heritage, inherited members, and public type signatures', () => {
  withFeatureFixture(
    {
      'src/features/class-extends-import/main/index.ts': `
        import { Infra } from './infrastructure/Infra';
        export class Api extends Infra {}
      `,
      'src/features/class-extends-import/main/infrastructure/Infra.ts':
        infrastructureSource('Infra'),
      'src/features/class-inherited-member/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Base {
          get store() {
            return Store;
          }
        }
        export class Api extends Base {}
      `,
      'src/features/class-inherited-member/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-method-parameter/main/index.ts': `
        import type { Input } from './infrastructure/Input';
        export class Api {
          run(input: Input): void {}
        }
      `,
      'src/features/class-method-parameter/main/infrastructure/Input.ts':
        'export interface Input {}',
      'src/features/class-method-return/main/index.ts': `
        import type { Output } from './infrastructure/Output';
        export class Api {
          run(): Output {
            throw new Error('not implemented');
          }
        }
      `,
      'src/features/class-method-return/main/infrastructure/Output.ts':
        'export interface Output {}',
      'src/features/class-constructor-signature/main/index.ts': `
        import type { Config } from './infrastructure/Config';
        export class Api {
          constructor(config: Config) {}
        }
      `,
      'src/features/class-constructor-signature/main/infrastructure/Config.ts':
        'export interface Config {}',
      'src/features/class-private-signatures-safe/main/index.ts': `
        import type { Secret } from './infrastructure/Secret';
        export class Api {
          private hidden(value: Secret): Secret {
            return value;
          }
          protected constructor(secret: Secret) {}
        }
      `,
      'src/features/class-private-signatures-safe/main/infrastructure/Secret.ts':
        'export interface Secret {}',
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-constructor-signature/main/index.ts',
        'src/features/class-extends-import/main/index.ts',
        'src/features/class-inherited-member/main/index.ts',
        'src/features/class-method-parameter/main/index.ts',
        'src/features/class-method-return/main/index.ts',
      ]);
    }
  );
});

test('traces public parameter-property defaults without exposing private constructor state', () => {
  withFeatureFixture(
    {
      'src/features/class-public-parameter-default/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(public store = Store) {}
        }
        export const api = new Api();
      `,
      'src/features/class-public-parameter-default/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-private-parameter-default-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(private store = Store) {}
        }
        export const api = new Api();
      `,
      'src/features/class-private-parameter-default-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-plain-parameter-default-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(store = Store) {
            void store;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-plain-parameter-default-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-public-parameter-default/main/index.ts',
      ]);
    }
  );
});

test('does not attribute nested callback returns to an enclosing public method', () => {
  withFeatureFixture(
    {
      'src/features/class-direct-method-return/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          run() {
            return Store;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-direct-method-return/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-nested-callback-return-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          run() {
            [1].map(() => {
              return Store;
            });
            return true;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-nested-callback-return-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-private-method-return-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          private run() {
            return Store;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-private-method-return-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-direct-method-return/main/index.ts',
      ]);
    }
  );
});

test('traces modeled object-mutator writes to constructed public instances', () => {
  withFeatureFixture(
    {
      'src/features/class-object-assign/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.assign(this, { store: Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-object-assign-shorthand/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.assign(this, { Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-shorthand/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-reflect-set/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Reflect.set(this, 'store', Store);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-reflect-set/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-define-property/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.defineProperty(this, 'store', { value: Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-property/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-define-properties/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.defineProperties(this, { store: { value: Store } });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-properties/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-private-object-assign-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          private store: unknown;
          constructor() {
            Object.assign(this, { store: Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-private-object-assign-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-other-object-assign-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.assign({}, { store: Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-other-object-assign-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-define-properties/main/index.ts',
        'src/features/class-define-property/main/index.ts',
        'src/features/class-object-assign-shorthand/main/index.ts',
        'src/features/class-object-assign/main/index.ts',
        'src/features/class-reflect-set/main/index.ts',
      ]);
    }
  );
});

test('traces constructor getter descriptors and local mutator aliases', () => {
  withFeatureFixture(
    {
      'src/features/class-define-property-getter/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.defineProperty(this, 'store', { get: () => Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-property-getter/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-global-mutator-self-method-name/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api { Object() { Object.assign(this, { store: Store }); } Reflect() { Reflect.set(this, 'store', Store); } }
        export const api = new Api();
      `,
      'src/features/class-global-mutator-self-method-name/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-alias/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            const fields = { store: Store };
            Object.assign(this, fields);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-alias/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-object-assign-destructured-declaration/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api { constructor() { const source = { fields: { store: Store } }; const { fields } = source; Object.assign(this, fields); } }
        export const api = new Api();
      `,
      'src/features/class-object-assign-destructured-declaration/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-destructured-assignment/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api { constructor() { let fields = {}; const source = { fields: { store: Store } }; ({ fields } = source); Object.assign(this, fields); } }
        export const api = new Api();
      `,
      'src/features/class-object-assign-destructured-assignment/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-destructured-default/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api { constructor() { const source = {}; const { fields = { store: Store } } = source; Object.assign(this, fields); } }
        export const api = new Api();
      `,
      'src/features/class-object-assign-destructured-default/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-destructured-assignment-default/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api { constructor() { let fields = {}; const source = {}; ({ fields = { store: Store } } = source); Object.assign(this, fields); } }
        export const api = new Api();
      `,
      'src/features/class-object-assign-destructured-assignment-default/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-destructured-rest/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api { constructor() { const source = { store: Store }; const { ...fields } = source; Object.assign(this, fields); } }
        export const api = new Api();
      `,
      'src/features/class-object-assign-destructured-rest/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-public-method/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          install() {
            const fields = { store: Store };
            Object.assign(this, fields);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-public-method/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-define-properties-alias/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            const descriptor = { value: Store };
            const descriptors = { store: descriptor };
            Object.defineProperties(this, descriptors);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-properties-alias/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-define-properties-getter-alias/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            const descriptors = { store: { get: () => Store } };
            Object.defineProperties(this, descriptors);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-properties-getter-alias/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-define-properties-alias/main/index.ts',
        'src/features/class-define-properties-getter-alias/main/index.ts',
        'src/features/class-define-property-getter/main/index.ts',
        'src/features/class-global-mutator-self-method-name/main/index.ts',
        'src/features/class-object-assign-alias/main/index.ts',
        'src/features/class-object-assign-destructured-assignment-default/main/index.ts',
        'src/features/class-object-assign-destructured-assignment/main/index.ts',
        'src/features/class-object-assign-destructured-declaration/main/index.ts',
        'src/features/class-object-assign-destructured-default/main/index.ts',
        'src/features/class-object-assign-destructured-rest/main/index.ts',
        'src/features/class-object-assign-public-method/main/index.ts',
      ]);
    }
  );
});

test('ignores constructor mutator aliases that cannot expose the implementation', () => {
  withFeatureFixture(
    {
      'src/features/class-define-property-setter-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.defineProperty(this, 'store', {
              set(value: unknown) {
                void value;
                void Store;
              },
            });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-property-setter-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-define-property-unreturned-getter-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            Object.defineProperty(this, 'store', {
              get: () => {
                void Store;
                return null;
              },
            });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-property-unreturned-getter-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-alias-rebound-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            let fields = { store: Store };
            fields = {};
            Object.assign(this, fields);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-alias-rebound-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-destructured-declaration-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api { constructor() { const source = { fields: {} }; const { fields = { store: Store } } = source; Object.assign(this, fields); } }
        export const api = new Api();
      `,
      'src/features/class-object-assign-destructured-declaration-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-destructured-assignment-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api { constructor() { let fields = { store: Store }; const source = { fields: {} }; ({ fields = { store: Store } } = source); Object.assign(this, fields); } }
        export const api = new Api();
      `,
      'src/features/class-object-assign-destructured-assignment-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-alias-other-target-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            const fields = { store: Store };
            Object.assign({}, fields);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-alias-other-target-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-define-properties-alias-rebound-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            let descriptors = { store: { value: Store } };
            descriptors = {};
            Object.defineProperties(this, descriptors);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-define-properties-alias-rebound-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-nested-this-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            const fields = { store: Store };
            function install(this: object) {
              Object.assign(this, fields);
            }
            void install;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-nested-this-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-deferred-arrow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            const fields = { store: Store };
            const install = () => Object.assign(this, fields);
            void install;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-deferred-arrow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), []);
    }
  );
});

test('keeps conditional constructor alias rebinds path-conservative', () => {
  withFeatureFixture(
    {
      'src/features/class-object-assign-conditional-rebind/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(condition: boolean) {
            let fields = { store: Store };
            if (condition) fields = {};
            Object.assign(this, fields);
          }
        }
        export const api = new Api(false);
      `,
      'src/features/class-object-assign-conditional-rebind/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-conditional-source/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(condition: boolean) {
            let fields = {};
            if (condition) fields = { store: Store };
            Object.assign(this, fields);
          }
        }
        export const api = new Api(false);
      `,
      'src/features/class-object-assign-conditional-source/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-false-rebind/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            let fields = { store: Store };
            if (false) fields = {};
            Object.assign(this, fields);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-false-rebind/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-true-rebind-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            let fields = { store: Store };
            if (true) fields = {};
            Object.assign(this, fields);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-true-rebind-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-all-branches-rebind-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(condition: boolean) {
            let fields = { store: Store };
            if (condition) fields = {};
            else fields = {};
            Object.assign(this, fields);
          }
        }
        export const api = new Api(false);
      `,
      'src/features/class-object-assign-all-branches-rebind-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-one-dangerous-branch/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(condition: boolean) {
            let fields = {};
            if (condition) fields = {};
            else fields = { store: Store };
            Object.assign(this, fields);
          }
        }
        export const api = new Api(false);
      `,
      'src/features/class-object-assign-one-dangerous-branch/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-unreachable-loop-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            let fields = {};
            while (false) fields = { store: Store };
            Object.assign(this, fields);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-unreachable-loop-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-unknown-loop/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(condition: boolean) {
            let fields = {};
            while (condition) {
              fields = { store: Store };
              break;
            }
            Object.assign(this, fields);
          }
        }
        export const api = new Api(false);
      `,
      'src/features/class-object-assign-unknown-loop/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-nullish-rebind-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            let fields = { store: Store };
            null ?? (fields = {});
            Object.assign(this, fields);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-nullish-rebind-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-non-nullish-rebind/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            let fields = { store: Store };
            false ?? (fields = {});
            Object.assign(this, fields);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-non-nullish-rebind/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-object-assign-conditional-rebind/main/index.ts',
        'src/features/class-object-assign-conditional-source/main/index.ts',
        'src/features/class-object-assign-false-rebind/main/index.ts',
        'src/features/class-object-assign-non-nullish-rebind/main/index.ts',
        'src/features/class-object-assign-one-dangerous-branch/main/index.ts',
        'src/features/class-object-assign-unknown-loop/main/index.ts',
      ]);
    }
  );
});

test('recognizes only unshadowed global constructor mutators', () => {
  withFeatureFixture(
    {
      'src/features/class-object-assign-parameter-shadow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor(Object: { assign(target: object, source: object): void }) {
            Object.assign(this, { store: Store });
          }
        }
        export const api = new Api({ assign() {} });
      `,
      'src/features/class-object-assign-parameter-shadow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-block-shadow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            {
              const Object = { assign() {} };
              Object.assign(this, { store: Store });
            }
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-block-shadow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-reflect-module-shadow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        const Reflect = { set() {} };
        class Api {
          constructor() {
            Reflect.set(this, 'store', Store);
          }
        }
        export const api = new Api();
      `,
      'src/features/class-reflect-module-shadow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-reflect-catch-shadow-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            try {
              throw null;
            } catch (Reflect) {
              Reflect.set(this, 'store', Store);
            }
          }
        }
        export const api = new Api();
      `,
      'src/features/class-reflect-catch-shadow-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-sibling-shadow/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          constructor() {
            {
              const Object = { assign() {} };
              void Object;
            }
            Object.assign(this, { store: Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-sibling-shadow/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-object-assign-type-shadow/main/index.ts': `
        import { Store } from './infrastructure/Store';
        type Object = { marker: true };
        class Api {
          constructor() {
            Object.assign(this, { store: Store });
          }
        }
        export const api = new Api();
      `,
      'src/features/class-object-assign-type-shadow/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-object-assign-sibling-shadow/main/index.ts',
        'src/features/class-object-assign-type-shadow/main/index.ts',
      ]);
    }
  );
});

test('keeps constructed instances instance-only while preserving their public instance type', () => {
  withFeatureFixture(
    {
      'src/features/class-instance-member/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          get store() {
            return Store;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-instance-member/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-instance-static-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          static get store() {
            return Store;
          }
        }
        export const api = new Api();
      `,
      'src/features/class-instance-static-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-instance-constructor-safe/main/index.ts': `
        import type { Config } from './infrastructure/Config';
        class Api {
          constructor(config: Config) {}
        }
        export const api = new Api(null as never);
      `,
      'src/features/class-instance-constructor-safe/main/infrastructure/Config.ts':
        'export interface Config {}',
      'src/features/class-instance-method-type/main/index.ts': `
        import type { Input } from './infrastructure/Input';
        class Api {
          run(input: Input): void {}
        }
        export const api = new Api();
      `,
      'src/features/class-instance-method-type/main/infrastructure/Input.ts':
        'export interface Input {}',
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-instance-member/main/index.ts',
        'src/features/class-instance-method-type/main/index.ts',
      ]);
    }
  );
});

test('uses the final class binding and remains conservative for conditional rebinds', () => {
  withFeatureFixture(
    {
      'src/features/class-rebind-final-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          get store() {
            return Store;
          }
        }
        Api = class {};
        export { Api };
      `,
      'src/features/class-rebind-final-safe/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-rebind-final-public/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {}
        Api = class {
          get store() {
            return Store;
          }
        };
        export { Api };
      `,
      'src/features/class-rebind-final-public/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-rebind-conditional/main/index.ts': `
        import { Store } from './infrastructure/Store';
        declare const enabled: boolean;
        class Api {
          get store() {
            return Store;
          }
        }
        if (enabled) Api = class {};
        export { Api };
      `,
      'src/features/class-rebind-conditional/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-rebind-conditional/main/index.ts',
        'src/features/class-rebind-final-public/main/index.ts',
      ]);
    }
  );
});

test('preserves public assignments from function constructors', () => {
  withFeatureFixture(
    {
      'src/features/function-constructor/main/index.ts': `
        import { Store } from './infrastructure/Store';
        function Api() {
          this.Store = Store;
        }
        export const api = new Api();
      `,
      'src/features/function-constructor/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/function-constructor/main/index.ts',
      ]);
    }
  );
});

test('traces snapshot defaults and inherited class type surfaces', () => {
  withFeatureFixture(
    {
      'src/features/class-default-snapshot/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {
          get store() {
            return Store;
          }
        }
        export default Api;
        Api = class {};
      `,
      'src/features/class-default-snapshot/main/infrastructure/Store.ts': infrastructureSource(),
      'src/features/class-default-snapshot-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        class Api {}
        export default Api;
        Api = class {
          get store() {
            return Store;
          }
        };
      `,
      'src/features/class-default-snapshot-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-inherited-constructor/main/index.ts': `
        import type { Config } from './infrastructure/Config';
        class Base {
          constructor(config: Config) {}
        }
        export class Api extends Base {}
      `,
      'src/features/class-inherited-constructor/main/infrastructure/Config.ts':
        'export interface Config {}',
      'src/features/class-index-signature/main/index.ts': `
        import type { Store } from './infrastructure/Store';
        export class Api {
          [key: string]: Store;
        }
      `,
      'src/features/class-index-signature/main/infrastructure/Store.ts':
        'export interface Store {}',
      'src/features/class-generator/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          *items() {
            yield Store;
          }
        }
      `,
      'src/features/class-generator/main/infrastructure/Store.ts': infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-default-snapshot/main/index.ts',
        'src/features/class-generator/main/index.ts',
        'src/features/class-index-signature/main/index.ts',
        'src/features/class-inherited-constructor/main/index.ts',
      ]);
    }
  );
});

test('resolves ordinary bound local functions and keeps their receiver immutable', () => {
  withFeatureFixture(
    {
      'src/features/class-static-block-function-direct-bind/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            install.bind(this)();
          }
        }
      `,
      'src/features/class-static-block-function-direct-bind/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-bind-alias/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.bind(this);
            invoke();
          }
        }
      `,
      'src/features/class-static-block-function-bind-alias/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-bind-chained-alias/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.bind(this);
            const alias = invoke;
            alias();
          }
        }
      `,
      'src/features/class-static-block-function-bind-chained-alias/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-bind-partial/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function (_value) {
              this.Store = Store;
            };
            const invoke = install.bind(this, 1);
            invoke();
          }
        }
      `,
      'src/features/class-static-block-function-bind-partial/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-bind-missing-receiver-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.bind();
            invoke.call(this);
          }
        }
      `,
      'src/features/class-static-block-function-bind-missing-receiver-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-function-bind-undefined-receiver-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.bind(undefined);
            invoke.call(this);
          }
        }
      `,
      'src/features/class-static-block-function-bind-undefined-receiver-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-function-bind-alias/main/index.ts',
        'src/features/class-static-block-function-bind-chained-alias/main/index.ts',
        'src/features/class-static-block-function-bind-partial/main/index.ts',
        'src/features/class-static-block-function-direct-bind/main/index.ts',
      ]);
    }
  );
});

test('does not recover invocation receivers omitted from detached method binds', () => {
  withFeatureFixture(
    {
      'src/features/class-static-block-call-bind-missing-receiver-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.call.bind();
            invoke.call(install, this);
          }
        }
      `,
      'src/features/class-static-block-call-bind-missing-receiver-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-call-bind-undefined-receiver-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.call.bind(undefined);
            invoke.call(install, this);
          }
        }
      `,
      'src/features/class-static-block-call-bind-undefined-receiver-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-call-bind-partial-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.call.bind(install);
            invoke();
          }
        }
      `,
      'src/features/class-static-block-call-bind-partial-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-call-bind-partial-late-argument/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              this.Store = Store;
            };
            const invoke = install.call.bind(install);
            invoke.call({}, this);
          }
        }
      `,
      'src/features/class-static-block-call-bind-partial-late-argument/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-call-bind-partial-late-argument/main/index.ts',
      ]);
    }
  );
});

test('isolates observed nested classes while tracing factory and inherited exposures', () => {
  withFeatureFixture(
    {
      'src/features/class-static-block-observed-nested-class-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            class Inner {
              static Store = Store;
            }
            const inspect = () => {
              void Inner;
            };
            inspect();
          }
        }
      `,
      'src/features/class-static-block-observed-nested-class-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-factory-nested-class/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            class Inner {
              static Store = Store;
            }
            function make() {
              return Inner;
            }
            this.Inner = make();
          }
        }
      `,
      'src/features/class-static-block-factory-nested-class/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-factory-observation-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            class Inner {
              static Store = Store;
            }
            function make() {
              void Inner;
              return class {};
            }
            this.Inner = make();
          }
        }
      `,
      'src/features/class-static-block-factory-observation-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-inherited-nested-class/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            class Base {
              static Store = Store;
            }
            class Inner extends Base {}
            this.Inner = Inner;
          }
        }
      `,
      'src/features/class-static-block-inherited-nested-class/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-factory-nested-class/main/index.ts',
        'src/features/class-static-block-inherited-nested-class/main/index.ts',
      ]);
    }
  );
});

test('respects abrupt completion through try and finally blocks', () => {
  withFeatureFixture(
    {
      'src/features/class-static-block-return-through-finally-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              try {
                return;
              } finally {
              }
              this.Store = Store;
            };
            install.call(this);
          }
        }
      `,
      'src/features/class-static-block-return-through-finally-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-finally-return-safe/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              try {
                throw new Error('stop');
              } finally {
                return;
              }
              this.Store = Store;
            };
            install.call(this);
          }
        }
      `,
      'src/features/class-static-block-finally-return-safe/main/infrastructure/Store.ts':
        infrastructureSource(),
      'src/features/class-static-block-catch-continues/main/index.ts': `
        import { Store } from './infrastructure/Store';
        export class Api {
          static {
            const install = function () {
              try {
                throw new Error('continue in catch');
              } catch {
              } finally {
              }
              this.Store = Store;
            };
            install.call(this);
          }
        }
      `,
      'src/features/class-static-block-catch-continues/main/infrastructure/Store.ts':
        infrastructureSource(),
    },
    (root) => {
      assert.deepEqual(implementationViolationSources(root), [
        'src/features/class-static-block-catch-continues/main/index.ts',
      ]);
    }
  );
});
