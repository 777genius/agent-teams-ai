import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inspectHostedBrowserEventStreamProof } from '../../../../scripts/ci/hosted-browser-event-stream-proof.mjs';

const globalName = '__agentTeamsHostedCoordinationEventStream';
const entryModuleId = 'src/renderer/hosted/hostedCoordinationEventStreamBrowserEntry.ts';
const requiredApi = [
  { globalKey: 'createHostedCoordinationEventBootstrapTransport', moduleId: 'bootstrap.ts' },
  { globalKey: 'createHostedCoordinationEventTransport', moduleId: 'transport.ts' },
];
const entry = {
  fileName: 'assets/browser-entry.js',
  imports: ['assets/shared.js'],
  exports: [],
  moduleIds: [entryModuleId],
  source: `import { createBootstrap as bootstrap, createTransport as transport } from './shared.js'; Object.defineProperty(globalThis, '${globalName}', { value: { createHostedCoordinationEventBootstrapTransport: bootstrap, createHostedCoordinationEventTransport: transport } });`,
};
const shared = {
  fileName: 'assets/shared.js',
  imports: [],
  exports: ['createBootstrap', 'createTransport'],
  moduleIds: ['bootstrap.ts', 'transport.ts'],
  source: 'export function createBootstrap() {} export function createTransport() {}',
};

function inspectMain(source) {
  return inspectHostedBrowserEventStreamProof({
    entryPaths: ['assets/main.js'],
    chunks: [entry, shared, {
      fileName: 'assets/main.js',
      imports: ['assets/browser-entry.js'],
      dynamicImports: [],
      exports: [],
      moduleIds: ['main.tsx'],
      source,
    }],
    entryModuleId,
    globalName,
    requiredApi,
  });
}

test('emitted graph accepts its declared imports', () => {
  assert.deepEqual(inspectMain('import "./browser-entry.js";').violations, []);
});

for (const [name, suffix] of [
  ['nested template interpolation', '\nfunction lazy(){return `${`prefix` + import("./not-in-graph.js")}`};'],
  ['U+2028 line comment terminator', '\n// comment\u2028import("./not-in-graph.js");'],
  ['U+2029 line comment terminator', '\n// comment\u2029import("./not-in-graph.js");'],
  ['postfix increment followed by division', '\nlet n=0; n++ / import("./not-in-graph.js") / 2;'],
  ['postfix division and an inert quote in a comment', '\nlet n=0; n++ / import("./not-in-graph.js") / 2; //"'],
  ['escaped dynamic source', '\nvoid import("./not-in-gra\\u0070h.js");'],
  ['late named reexport', '\nexport { missing } from "./not-in-graph.js";'],
  ['late wildcard reexport', '\nexport * from "./not-in-graph.js";'],
  ['unresolved dynamic expression', '\nvoid import("./" + "not-in-graph.js");'],
]) {
  test(`emitted graph rejects an undeclared import after ${name}`, () => {
    const proof = inspectMain(`import "./browser-entry.js";${suffix}`);
    assert.ok(proof.violations.includes('hosted_renderer_graph_emitted_static_edge_invalid:assets/main.js'));
  });
}

test('emitted graph ignores import text in inert JavaScript grammar positions', () => {
  const source = `import "./browser-entry.js";
    const text = 'import("./not-in-graph.js")';
    const pattern = /import\\("\\.\\/not-in-graph\\.js"\\)/;
    const holder = { import: './not-in-graph.js' };
    void [text, pattern, holder.import, import.meta.url];`;
  assert.deepEqual(inspectMain(source).violations, []);
});
