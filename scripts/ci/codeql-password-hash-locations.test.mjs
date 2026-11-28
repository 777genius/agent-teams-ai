import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  collectPasswordHashLocations,
  readPasswordHashLocations,
} from './codeql-password-hash-locations.mjs';

const ruleId = 'js/insufficient-password-hash';
const privateText = 'PRIVATE-TEST-NEVER-EXPORT';
const options = {
  workspace: '/TEST-checkout',
  trackedPaths: ['src/source.ts', 'src/sink.ts', 'src/with space.ts'],
  provenance: { checkoutSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), analysisOutcome: 'success' },
};
const location = (uri = 'src/source.ts', line = 8) => ({
  physicalLocation: {
    artifactLocation: { uri },
    region: { startLine: line, startColumn: 3, snippet: { text: privateText } },
  },
  message: { text: privateText },
  properties: { token: privateText },
});
function fixture() {
  return {
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'CodeQL', rules: [{ id: ruleId }] } },
        invocations: [{ executionSuccessful: true }],
        results: [
          {
            ruleId,
            ruleIndex: 0,
            message: { text: privateText },
            properties: { secret: privateText },
            locations: [location('src/sink.ts', 27)],
            relatedLocations: [location()],
            codeFlows: [
              {
                threadFlows: [
                  {
                    locations: [
                      { location: location() },
                      { location: location('src/sink.ts', 27) },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
const omissionKeys = [
  'malformedRuleReference',
  'unresolvedRuleReference',
  'conflictingRuleReference',
  'ambiguousRuleReference',
  'ruleMetadataLimit',
  'other',
];
const collect = (source, custom = options) => {
  const report = collectPasswordHashLocations(source, custom);
  assert.deepEqual(Object.keys(report.omissionReasons), omissionKeys);
  assert.ok(
    Object.values(report.omissionReasons).every(
      (value) => Number.isSafeInteger(value) && value >= 0
    )
  );
  assert.equal(
    Object.values(report.omissionReasons).reduce((sum, value) => sum + value, 0),
    report.counts.omitted
  );
  return report;
};
const componentGuid = '12345678-abcd-4abc-8abc-123456789abc';
const descriptorGuid = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';

for (const [name, mutate] of [
  [
    'explicit driver ID and index',
    (run) => {
      run.results[0].rule = { id: ruleId, index: 0 };
    },
  ],
  [
    'empty reference inherits both top-level fields',
    (run) => {
      run.results[0].rule = {};
    },
  ],
  [
    'nested ID inherits top-level index',
    (run) => {
      delete run.results[0].ruleId;
      run.results[0].rule = { id: ruleId };
    },
  ],
  [
    'nested index inherits top-level ID',
    (run) => {
      delete run.results[0].ruleIndex;
      run.results[0].rule = { index: 0 };
    },
  ],
  [
    'extension-local index with agreeing component identity',
    (run) => {
      run.tool.extensions = [
        {
          name: privateText,
          guid: componentGuid,
          rules: [{ id: ruleId, guid: descriptorGuid, properties: { secret: privateText } }],
        },
      ];
      run.tool.driver.rules = [{ id: 'js/unrelated-rule' }];
      run.results[0].rule = {
        id: ruleId,
        index: 0,
        guid: descriptorGuid,
        toolComponent: { index: 0, name: privateText, guid: componentGuid },
      };
    },
  ],
  [
    'driver and descriptor GUID-only selectors',
    (run) => {
      run.tool.driver.guid = componentGuid;
      run.tool.driver.rules[0].guid = descriptorGuid;
      delete run.results[0].ruleIndex;
      run.results[0].rule = {
        guid: descriptorGuid.toUpperCase(),
        toolComponent: { guid: componentGuid.toUpperCase() },
      };
    },
  ],
  [
    'extension GUID-only selectors',
    (run) => {
      run.tool.extensions = [
        { name: privateText, guid: componentGuid, rules: [{ id: ruleId, guid: descriptorGuid }] },
      ];
      run.tool.driver.rules = [{ id: 'js/unrelated-rule' }];
      delete run.results[0].ruleIndex;
      run.results[0].rule = {
        guid: descriptorGuid,
        toolComponent: { guid: componentGuid, name: privateText },
      };
    },
  ],
]) {
  test('standard SARIF reference: ' + name, () => {
    const source = fixture();
    mutate(source.runs[0]);
    const report = collect(source);
    assert.equal(report.status, 'complete');
    assert.deepEqual(report.results, collect(fixture()).results);
    assert.deepEqual(report.provenance, options.provenance);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|snippet|properties|message|abcdefab/);
  });
}

test('retains exact nested source/sink flow coordinates without any private SARIF text', () => {
  const report = collect(fixture());
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.results[0], {
    runIndex: 0,
    resultIndex: 0,
    locations: [
      { kind: 'locations', locationIndex: 0, path: 'src/sink.ts', startLine: 27, startColumn: 3 },
      {
        kind: 'relatedLocations',
        locationIndex: 0,
        path: 'src/source.ts',
        startLine: 8,
        startColumn: 3,
      },
      {
        kind: 'flow',
        codeFlowIndex: 0,
        threadFlowIndex: 0,
        locationIndex: 0,
        path: 'src/source.ts',
        startLine: 8,
        startColumn: 3,
      },
      {
        kind: 'flow',
        codeFlowIndex: 0,
        threadFlowIndex: 0,
        locationIndex: 1,
        path: 'src/sink.ts',
        startLine: 27,
        startColumn: 3,
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|snippet|properties|message|\/TEST-checkout/);
});

test('resolves rule, artifact and shared thread-location indices against the exact checkout base', () => {
  const source = fixture(),
    run = source.runs[0],
    result = run.results[0];
  delete result.ruleId;
  run.originalUriBaseIds = { SRCROOT: { uri: pathToFileURL(options.workspace + '/').href } };
  run.artifacts = [
    {
      location: { uri: 'src/with%20space.ts', uriBaseId: 'SRCROOT' },
      contents: { text: privateText },
    },
  ];
  const indexed = {
    physicalLocation: {
      artifactLocation: { index: 0, uri: 'src/with space.ts' },
      region: { startLine: 12 },
    },
  };
  result.relatedLocations = [indexed];
  run.threadFlowLocations = [{ location: indexed }];
  result.codeFlows[0].threadFlows[0].locations[0] = { index: 0 };
  const report = collect(source);
  assert.equal(report.status, 'complete');
  assert.equal(report.results[0].locations[1].path, 'src/with space.ts');
  assert.equal(report.results[0].locations[2].path, 'src/with space.ts');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|file:/);
});

for (const explicit of [false, true]) {
  test('accepts matching artifact self-indices with explicit URI=' + explicit, () => {
    const source = fixture(),
      run = source.runs[0],
      result = run.results[0],
      paths = ['src/source.ts', 'src/sink.ts'];
    run.originalUriBaseIds = { SRCROOT: { uri: pathToFileURL(options.workspace + '/').href } };
    run.artifacts = paths.map((uri, index) => ({
      location: { uri, index, uriBaseId: 'SRCROOT' },
      contents: { text: privateText },
    }));
    for (const value of [
      ...result.locations,
      ...result.relatedLocations,
      ...result.codeFlows[0].threadFlows[0].locations.map((entry) => entry.location),
    ]) {
      const physical = value.physicalLocation;
      const index = paths.indexOf(physical.artifactLocation.uri);
      assert.ok(index >= 0);
      physical.artifactLocation = {
        index,
        ...(explicit ? { uri: paths[index], uriBaseId: 'SRCROOT' } : {}),
      };
    }
    const report = collect(source);
    assert.deepEqual(report, collect(fixture()));
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|file:|snippet|contents/);
  });
}

for (const selfIndex of [1, -1, 0.5, '0', null]) {
  test('refuses a mismatching or malformed artifact self-index: ' + selfIndex, () => {
    const source = fixture(),
      run = source.runs[0];
    run.artifacts = [
      { location: { uri: 'src/sink.ts', index: selfIndex } },
      { location: { uri: 'src/source.ts', index: 1 } },
    ];
    run.results[0].locations[0].physicalLocation.artifactLocation = { index: 0 };
    const report = collect(source);
    assert.equal(report.status, 'partial');
    assert.ok(report.counts.omitted > 0);
    assert.equal(
      report.results[0].locations.some((value) => value.kind === 'locations'),
      false
    );
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|file:|snippet|contents/);
  });
}

for (const uri of [
  '/etc/secret',
  'C:/secret',
  'C:%5csecret',
  'file:///secret',
  'https://example.test/key',
  '//other/secret',
  '../src/source.ts',
  '%2e%2e/src/source.ts',
  'src/%2e%2e/source.ts',
  './src/source.ts',
  'src/source.ts?secret',
  'src/source.ts%23secret',
  'src/%00source.ts',
  'src/%ZZsource.ts',
  'src/untracked-secret.ts',
]) {
  test('unsafe or untracked selected-rule location makes evidence partial: ' + uri, () => {
    const source = fixture();
    source.runs[0].results[0].locations[0] = location(uri);
    const report = collect(source);
    assert.equal(report.status, 'partial');
    assert.ok(report.counts.omitted > 0);
    assert.equal(
      report.results[0].locations.some((value) => value.kind === 'locations'),
      false
    );
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|untracked-secret|example\.test|\/etc/);
  });
}

test('ambiguous rule/artifact/base references and invalid coordinates never become complete evidence', () => {
  for (const mutate of [
    (run) => {
      run.results[0].ruleIndex = 1;
    },
    (run) => {
      delete run.results[0].ruleId;
      delete run.results[0].ruleIndex;
    },
    (run) => {
      delete run.results[0].ruleId;
      run.results[0].ruleIndex = 'PRIVATE';
    },
    (run) => {
      run.results[0].ruleId = 'unrelated';
    },
    (run) => {
      run.results[0].locations[0].physicalLocation.artifactLocation = { index: 500 };
    },
    (run) => {
      run.artifacts = [{ location: { uri: 'src/source.ts' } }];
      run.results[0].locations[0].physicalLocation.artifactLocation = {
        index: 0,
        uri: 'src/sink.ts',
      };
    },
    (run) => {
      run.results[0].locations[0].physicalLocation.artifactLocation.uriBaseId = 'missing';
    },
    (run) => {
      run.originalUriBaseIds = { ROOT: { uri: 'file:///PRIVATE-other/' } };
      run.results[0].locations[0].physicalLocation.artifactLocation.uriBaseId = 'ROOT';
    },
    (run) => {
      run.results[0].locations[0].physicalLocation.region.startLine = 0;
    },
    (run) => {
      run.results[0].locations[0].physicalLocation.region.startColumn = 1.5;
    },
    (run) => {
      run.results[0].locations[0].physicalLocation.region.endLine = 1;
    },
    (run) => {
      run.results[0].locations[0].physicalLocation.region.endColumn = 1;
    },
    (run) => {
      run.results[0].codeFlows = [];
    },
  ]) {
    const source = fixture();
    mutate(source.runs[0]);
    const report = collect(source);
    assert.equal(report.status, 'partial');
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|unrelated/);
  }
});

for (const [name, reason, mutate] of [
  [
    'top-level/nested ID conflict',
    'conflictingRuleReference',
    (run) => {
      run.results[0].rule = { id: 'js/unrelated-rule', index: 0 };
    },
  ],
  [
    'top-level/nested index conflict',
    'conflictingRuleReference',
    (run) => {
      run.results[0].rule = { index: 1 };
    },
  ],
  [
    'explicit ID alone cannot search metadata',
    'unresolvedRuleReference',
    (run) => {
      delete run.results[0].ruleIndex;
      run.results[0].rule = { id: ruleId };
    },
  ],
  [
    'empty rule without inherited locator',
    'unresolvedRuleReference',
    (run) => {
      delete run.results[0].ruleIndex;
      run.results[0].rule = {};
    },
  ],
  [
    'missing extension never uses driver',
    'unresolvedRuleReference',
    (run) => {
      run.results[0].rule = { index: 0, toolComponent: { index: 0 } };
    },
  ],
  [
    'extension descriptor conflict never falls back to driver',
    'conflictingRuleReference',
    (run) => {
      run.tool.extensions = [{ name: privateText, rules: [{ id: 'js/unrelated-rule' }] }];
      run.results[0].rule = { index: 0, toolComponent: { index: 0 } };
    },
  ],
  [
    'missing descriptor metadata',
    'unresolvedRuleReference',
    (run) => {
      delete run.tool.driver.rules;
      run.results[0].rule = { index: 0 };
    },
  ],
  [
    'component name alone never searches extensions',
    'conflictingRuleReference',
    (run) => {
      run.tool.extensions = [{ name: privateText, rules: [{ id: ruleId }] }];
      run.results[0].rule = { index: 0, toolComponent: { name: privateText } };
    },
  ],
  [
    'descriptor GUID cannot select a different index',
    'conflictingRuleReference',
    (run) => {
      run.tool.driver.rules.push({ id: 'js/unrelated-rule', guid: descriptorGuid });
      run.results[0].rule = { index: 0, guid: descriptorGuid };
    },
  ],
  [
    'component GUID cannot select a different index',
    'conflictingRuleReference',
    (run) => {
      run.tool.driver.guid = componentGuid;
      run.tool.extensions = [{ name: privateText, rules: [{ id: ruleId }] }];
      run.results[0].rule = { index: 0, toolComponent: { index: 0, guid: componentGuid } };
    },
  ],
  [
    'descriptor GUID is ambiguous even with index',
    'ambiguousRuleReference',
    (run) => {
      run.tool.driver.rules = [
        { id: ruleId, guid: descriptorGuid },
        { id: ruleId, guid: descriptorGuid.toUpperCase() },
      ];
      run.results[0].rule = { index: 0, guid: descriptorGuid };
    },
  ],
  [
    'component GUID is ambiguous even with index',
    'ambiguousRuleReference',
    (run) => {
      run.tool.driver.guid = componentGuid;
      run.tool.extensions = [{ name: privateText, guid: componentGuid, rules: [{ id: ruleId }] }];
      run.results[0].rule = { index: 0, toolComponent: { index: 0, guid: componentGuid } };
    },
  ],
  [
    'rule GUID is scoped to its component',
    'unresolvedRuleReference',
    (run) => {
      run.tool.extensions = [{ name: privateText, rules: [{ id: ruleId, guid: descriptorGuid }] }];
      run.results[0].rule = { index: 0, guid: descriptorGuid };
    },
  ],
  [
    'unknown component GUID',
    'unresolvedRuleReference',
    (run) => {
      run.results[0].rule = { index: 0, toolComponent: { guid: componentGuid } };
    },
  ],
  [
    'unrelated identity conflicts are still partial',
    'conflictingRuleReference',
    (run) => {
      run.tool.driver.rules = [{ id: 'js/unrelated-a' }];
      run.results[0].ruleId = 'js/unrelated-b';
      run.results[0].rule = { index: 0 };
    },
  ],
  ...[null, privateText, []].map((value) => [
    'malformed rule object',
    'malformedRuleReference',
    (run) => {
      run.results[0].rule = value;
    },
  ]),
  ...[null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, privateText].map((value) => [
    'malformed nested index',
    'malformedRuleReference',
    (run) => {
      run.results[0].rule = { index: value };
    },
  ]),
  ...[null, [], privateText].map((value) => [
    'malformed component object',
    'malformedRuleReference',
    (run) => {
      run.results[0].rule = { toolComponent: value };
    },
  ]),
  ...[{ index: -1 }, { index: 0.5 }, { name: null }, { guid: privateText }].map((value) => [
    'malformed component selector',
    'malformedRuleReference',
    (run) => {
      run.results[0].rule = { toolComponent: value };
    },
  ]),
  ...[{ id: null }, { guid: privateText }, { guid: descriptorGuid + '\n' }].map((value) => [
    'malformed rule selector',
    'malformedRuleReference',
    (run) => {
      run.results[0].rule = value;
    },
  ]),
  ...[null, {}].map((value) => [
    'malformed rules array',
    'malformedRuleReference',
    (run) => {
      run.tool.driver.rules = value;
      run.results[0].rule = { index: 0 };
    },
  ]),
  ...[null, {}].map((value) => [
    'malformed extensions array',
    'malformedRuleReference',
    (run) => {
      run.tool.extensions = value;
      run.results[0].rule = { index: 0, toolComponent: { index: 0 } };
    },
  ]),
  ...[{ id: null }, { id: ruleId, guid: privateText }].map((value) => [
    'malformed descriptor identity',
    'malformedRuleReference',
    (run) => {
      run.tool.driver.rules = [value];
      run.results[0].rule = { index: 0 };
    },
  ]),
]) {
  test('refuses SARIF reference: ' + name, () => {
    const source = fixture();
    mutate(source.runs[0]);
    const report = collect(source);
    assert.equal(report.status, 'partial');
    assert.equal(report.omissionReasons[reason], 1);
    assert.equal(report.counts.omitted, 1);
    assert.deepEqual(report.results, []);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|unrelated|abcdefab/);
  });
}

test('descriptor index disambiguates duplicate IDs without requiring unique text', () => {
  const source = fixture(),
    run = source.runs[0];
  run.tool.driver.rules.push({ id: ruleId, guid: descriptorGuid });
  run.results[0].ruleIndex = 1;
  run.results[0].rule = { index: 1, guid: descriptorGuid, toolComponent: { name: 'CodeQL' } };
  assert.equal(collect(source).status, 'complete');
});

test('bare legacy ruleId does not require invented metadata or a rule object', () => {
  const source = fixture();
  delete source.runs[0].results[0].ruleIndex;
  delete source.runs[0].tool.driver.rules;
  assert.equal(collect(source).status, 'complete');
  assert.deepEqual(collect(source).results, collect(fixture()).results);
});

test('hierarchical rule IDs are checked against the resolved descriptor without leaking suffixes', () => {
  for (const suffix of ['', '/', '/' + privateText]) {
    const source = fixture(),
      result = source.runs[0].results[0];
    result.ruleId = ruleId + suffix;
    result.rule = { id: result.ruleId, index: 0 };
    const report = collect(source);
    assert.equal(report.status, 'complete');
    assert.equal(report.results.length, 1);
    assert.equal(report.ruleId, ruleId);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  }
  for (const suffix of ['-extra', '/first/second']) {
    const source = fixture();
    source.runs[0].results[0].ruleId = ruleId + suffix;
    assert.equal(collect(source).omissionReasons.conflictingRuleReference, 1);
  }
  const source = fixture();
  source.runs[0].tool.driver.rules[0].id = 'js';
  const report = collect(source);
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.results, []);
});

test('valid unrelated explicit references are silent and never inspect their location payloads', () => {
  const source = fixture(),
    run = source.runs[0];
  run.tool.driver.rules.push({ id: 'js/unrelated-rule', properties: { secret: privateText } });
  const unrelated = {
    ruleId: 'js/unrelated-rule',
    rule: { index: 1 },
    locations: [location('/PRIVATE')],
    codeFlows: privateText,
    message: { text: privateText },
  };
  run.results.push(unrelated);
  const report = collect(source);
  assert.equal(report.status, 'complete');
  assert.equal(report.counts.results, 2);
  assert.deepEqual(report.results, collect(fixture()).results);
  assert.equal(report.counts.locations, 4);
  assert.equal(report.counts.omitted, 0);
  run.results = [unrelated];
  assert.equal(collect(source).status, 'complete');
  assert.deepEqual(collect(source).results, []);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|unrelated/);
});

function metadataFixture(count, selected = count - 1) {
  const source = fixture(),
    run = source.runs[0];
  run.tool.driver.rules = Array.from({ length: count }, () => ({ id: 'js/unrelated-rule' }));
  run.tool.driver.rules[selected] = { id: ruleId, guid: descriptorGuid };
  delete run.results[0].ruleIndex;
  run.results[0].rule = { guid: descriptorGuid };
  return source;
}

test('metadata GUID uniqueness must complete within the separate global visitation ceiling', () => {
  assert.equal(collect(metadataFixture(9999)).status, 'complete');
  const exhausted = collect(metadataFixture(10000, 0));
  assert.equal(exhausted.status, 'partial');
  assert.deepEqual(exhausted.results, []);
  assert.equal(
    exhausted.omissionReasons.ruleMetadataLimit,
    1,
    'first match cannot replace uniqueness'
  );
  const multi = metadataFixture(5000);
  multi.runs.push(metadataFixture(5000).runs[0]);
  const acrossRuns = collect(multi);
  assert.equal(acrossRuns.omissionReasons.ruleMetadataLimit, 1);
  assert.deepEqual(
    acrossRuns.results.map((value) => value.runIndex),
    [0]
  );
});

test('repeated references reuse bounded successful and failed metadata reads', () => {
  const source = metadataFixture(5000),
    run = source.runs[0];
  run.results = Array.from({ length: 40 }, () => structuredClone(run.results[0]));
  assert.equal(collect(source).status, 'complete');
  const invalid = fixture();
  invalid.runs[0].tool.driver.rules = [null];
  invalid.runs[0].results = Array.from({ length: 9999 }, () => ({ ruleIndex: 0 }));
  invalid.runs.push(fixture().runs[0]);
  const report = collect(invalid);
  assert.equal(report.omissionReasons.malformedRuleReference, 9999);
  assert.equal(report.omissionReasons.ruleMetadataLimit, 0);
  assert.deepEqual(
    report.results.map((value) => value.runIndex),
    [1]
  );
});

test('unrelated results are omitted and failed analysis cannot look like a complete empty result', () => {
  const source = fixture(),
    run = source.runs[0];
  run.results[0].ruleId = 'unrelated';
  delete run.results[0].ruleIndex;
  assert.deepEqual(collect(source).results, []);
  assert.equal(collect(source).status, 'complete');
  assert.equal(
    collect(source, {
      ...options,
      provenance: { ...options.provenance, analysisOutcome: 'failure' },
    }).status,
    'partial'
  );
  run.invocations[0].executionSuccessful = false;
  assert.equal(collect(source).status, 'partial');
  run.invocations[0].executionSuccessful = 'false';
  assert.equal(collect(source).status, 'partial');
  run.invocations[0] = {
    executionSuccessful: true,
    toolExecutionNotifications: [{ level: 'error', message: { text: privateText } }],
  };
  assert.equal(collect(source).status, 'partial');
  assert.doesNotMatch(JSON.stringify(collect(source)), /PRIVATE/);
});

test('explicit invalid indexed URI/base and malformed optional related locations are partial', () => {
  for (const reference of [
    { index: 0, uri: null },
    { index: 0, uriBaseId: null },
    { index: 0, uri: 1 },
    { index: 0, uriBaseId: [] },
  ]) {
    const source = fixture(),
      run = source.runs[0];
    run.artifacts = [{ location: { uri: 'src/source.ts' } }];
    run.results[0].locations[0].physicalLocation.artifactLocation = reference;
    const report = collect(source);
    assert.equal(report.status, 'partial');
    assert.equal(
      report.results[0].locations.some((value) => value.kind === 'locations'),
      false
    );
  }
  for (const relatedLocations of [null, {}, 'PRIVATE']) {
    const source = fixture();
    source.runs[0].results[0].relatedLocations = relatedLocations;
    assert.equal(collect(source).status, 'partial');
    assert.doesNotMatch(JSON.stringify(collect(source)), /PRIVATE/);
  }
  const source = fixture();
  delete source.runs[0].results[0].relatedLocations;
  assert.equal(collect(source).status, 'complete');
});

test('invalid shared thread indices still consume the global visited-location budget', () => {
  const source = fixture();
  source.runs[0].results[0].codeFlows[0].threadFlows = Array.from({ length: 2 }, () => ({
    locations: Array.from({ length: 4096 }, () => ({ index: -1 })),
  }));
  const report = collect(source);
  assert.equal(report.status, 'partial');
  assert.equal(report.counts.locations, 4096);
  assert.ok(report.counts.omitted <= 4098, 'rejected references cannot bypass the visitation cap');
});

test('count limits also bound rejected locations and report incomplete selected results', () => {
  const source = fixture(),
    result = source.runs[0].results[0];
  result.codeFlows[0].threadFlows[0].locations = Array.from({ length: 5000 }, () => ({
    location: location('../PRIVATE'),
  }));
  const report = collect(source);
  assert.equal(report.status, 'partial');
  assert.equal(report.counts.locations, 4096);
  assert.ok(report.counts.omitted > 0);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  source.runs[0].results = Array.from({ length: 10_001 }, () => ({ ruleId: 'unrelated' }));
  assert.equal(collect(source).status, 'partial');
  assert.equal(collect(source).counts.results, 10_000);
  assert.equal(collect({ version: '2.1.0', runs: [] }).status, 'unavailable');
});

test('unreadable, truncated and oversized input produce a text-free unavailable report', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-codeql-locations-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'javascript.sarif');
  assert.equal(readPasswordHashLocations(path, options).status, 'unavailable');
  writeFileSync(path, '{"PRIVATE-TEST-NEVER-EXPORT":');
  assert.doesNotMatch(JSON.stringify(readPasswordHashLocations(path, options)), /PRIVATE/);
  assert.equal(readPasswordHashLocations(path, options).status, 'unavailable');
  truncateSync(path, 64 * 1024 * 1024 + 1);
  assert.equal(readPasswordHashLocations(path, options).status, 'unavailable');
  writeFileSync(path, JSON.stringify(fixture()));
  assert.equal(readPasswordHashLocations(path, options).status, 'complete');
});

test('CLI binds the real Git checkout, refuses changed source and never overwrites an old output', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-codeql-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=TEST');
  writeFileSync(join(directory, 'source.ts'), 'export const value = 1;\n');
  git('add', 'source.ts');
  git(
    '-c',
    'user.name=TEST',
    '-c',
    'user.email=TEST@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'TEST source'
  );
  const source = fixture();
  source.runs[0].tool.extensions = [{ name: privateText, rules: [{ id: ruleId }] }];
  source.runs[0].results[0].rule = { index: 0, toolComponent: { index: 0 } };
  for (const value of source.runs[0].results[0].locations)
    value.physicalLocation.artifactLocation.uri = 'source.ts';
  source.runs[0].results[0].relatedLocations = [];
  source.runs[0].results[0].codeFlows[0].threadFlows[0].locations = [
    { location: location('source.ts') },
  ];
  writeFileSync(join(directory, 'javascript.sarif'), JSON.stringify(source));
  const output = join(directory, 'codeql-password-hash-locations.json');
  const env = {
    ...process.env,
    GITHUB_SHA: git('rev-parse', 'HEAD'),
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: 'analyze',
    RUNNER_TEMP: directory,
    CODEQL_ANALYSIS_OUTCOME: 'success',
    CODEQL_SARIF_DIRECTORY: directory,
    CODEQL_FLOW_OUTPUT: output,
  };
  const run = () =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./codeql-password-hash-locations.mjs', import.meta.url))],
      { cwd: directory, env, encoding: 'utf8' }
    );
  const completed = run();
  assert.equal(completed.status, 0);
  const original = readFileSync(output, 'utf8'),
    report = JSON.parse(original);
  assert.equal(report.status, 'complete');
  assert.equal(report.provenance.checkoutSha, env.GITHUB_SHA);
  assert.equal(report.provenance.treeSha, git('rev-parse', 'HEAD^{tree}'));
  assert.deepEqual(JSON.parse(completed.stdout).omissionReasons, report.omissionReasons);
  assert.doesNotMatch(
    original + completed.stdout + completed.stderr,
    /PRIVATE|snippet|properties|message/
  );
  assert.equal(run().status, 1, 'existing output is never adopted as current evidence');
  assert.equal(readFileSync(output, 'utf8'), original);
  rmSync(output);
  writeFileSync(join(directory, 'source.ts'), 'export const value = 2;\n');
  const changed = run();
  assert.equal(changed.status, 1);
  assert.doesNotMatch(changed.stderr, /PRIVATE/);
  assert.throws(() => readFileSync(output));
});

test('CLI refuses an oversized diagnostic without writing partial output or private metadata', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-codeql-output-budget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=TEST');
  const segments = Array.from({ length: 4 }, (_, i) => String(i) + 'x'.repeat(90));
  mkdirSync(join(directory, ...segments), { recursive: true });
  const path = segments.join('/') + '/source.ts';
  writeFileSync(join(directory, path), 'export const value = 1;\n');
  git('add', path);
  git(
    '-c',
    'user.name=TEST',
    '-c',
    'user.email=TEST@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'TEST source'
  );
  const source = fixture(),
    result = source.runs[0].results[0];
  result.locations = Array.from({ length: 4096 }, () => location(path));
  result.relatedLocations = [];
  writeFileSync(join(directory, 'javascript.sarif'), JSON.stringify(source));
  const output = join(directory, 'codeql-password-hash-locations.json');
  const completed = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./codeql-password-hash-locations.mjs', import.meta.url))],
    {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_SHA: git('rev-parse', 'HEAD'),
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'analyze',
        CODEQL_ANALYSIS_OUTCOME: 'success',
        RUNNER_TEMP: directory,
        CODEQL_SARIF_DIRECTORY: directory,
        CODEQL_FLOW_OUTPUT: output,
      },
    }
  );
  assert.equal(completed.status, 1);
  assert.equal(completed.stdout, '');
  assert.equal(completed.stderr, 'CodeQL source-location diagnostic unavailable\n');
  assert.throws(() => readFileSync(output));
});

test('CLI accepts only committed regular blobs and marks symlink/gitlink coordinates partial', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'TEST-codeql-tree-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'repo'),
    analysis = join(root, 'analysis'),
    temporary = join(root, 'temporary');
  for (const path of [directory, analysis, temporary]) mkdirSync(path);
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=TEST');
  const executable = 'with space\tname.ts';
  writeFileSync(join(directory, 'regular.ts'), 'export const value = 1;\n');
  writeFileSync(join(directory, executable), 'export const value = 2;\n');
  chmodSync(join(directory, executable), 0o755);
  writeFileSync(join(root, 'outside.ts'), privateText);
  symlinkSync('../outside.ts', join(directory, 'linked.ts'), 'file');
  git('add', 'regular.ts', executable, 'linked.ts');
  git('update-index', '--chmod=+x', executable);
  git(
    '-c',
    'user.name=TEST',
    '-c',
    'user.email=TEST@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'TEST source'
  );
  const first = git('rev-parse', 'HEAD');
  mkdirSync(join(directory, 'submodule'));
  git('update-index', '--add', '--cacheinfo', '160000', first, 'submodule');
  git(
    '-c',
    'user.name=TEST',
    '-c',
    'user.email=TEST@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'TEST gitlink'
  );
  git('diff', '--quiet', 'HEAD', '--');
  const tree = git('ls-tree', '-r', '-z', '--full-tree', 'HEAD');
  assert.match(tree, /100644 blob [a-f0-9]{40}\tregular\.ts\0/);
  assert.match(tree, /100755 blob [a-f0-9]{40}\twith space\tname\.ts\0/);
  assert.match(tree, /120000 blob [a-f0-9]{40}\tlinked\.ts\0/);
  assert.match(tree, /160000 commit [a-f0-9]{40}\tsubmodule\0/);
  const source = fixture(),
    selected = source.runs[0].results[0];
  const paths = ['regular.ts', executable, 'linked.ts', 'submodule'];
  selected.locations = paths.map((path) => location(encodeURI(path), 1));
  selected.relatedLocations = [];
  selected.codeFlows[0].threadFlows[0].locations = paths.map((path) => ({
    location: location(encodeURI(path), 1),
  }));
  writeFileSync(join(analysis, 'javascript.sarif'), JSON.stringify(source));
  const output = join(temporary, 'codeql-password-hash-locations.json');
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./codeql-password-hash-locations.mjs', import.meta.url))],
    {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_SHA: git('rev-parse', 'HEAD'),
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'analyze',
        CODEQL_ANALYSIS_OUTCOME: 'success',
        CODEQL_SARIF_DIRECTORY: analysis,
        CODEQL_FLOW_OUTPUT: output,
        RUNNER_TEMP: temporary,
      },
    }
  );
  assert.equal(result.status, 0, 'the CLI reaches projection under valid source provenance');
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.status, 'partial');
  assert.ok(report.counts.omitted > 0);
  assert.deepEqual(
    [...new Set(report.results[0].locations.map((value) => value.path))].sort(),
    ['regular.ts', executable].sort()
  );
  assert.doesNotMatch(
    JSON.stringify(report) + result.stdout + result.stderr,
    /PRIVATE|linked\.ts|submodule|outside\.ts/
  );
});
