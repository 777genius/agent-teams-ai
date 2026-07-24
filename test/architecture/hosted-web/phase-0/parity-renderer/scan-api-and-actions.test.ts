import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type ChildControlCatalog,
  CONTROL_ROOTS,
  discoverControlClosure,
  findDynamicDispatch,
  isEventProp,
  LEGACY_CHILD_API_ACTION_IDS,
  scanApiInterfaces,
  scanControls,
  type SemanticRow,
  validateApiDispositions,
  validateChildControlCatalog,
  validateControlClosure,
  validateJsonSchema,
  validateLegacyChildApiActionMappings,
  validateMountedControlRoots,
  validateSemanticCatalog,
} from '../../../../../scripts/hosted-web/phase-0/parity-renderer/scan-api-and-actions';

const source = `
  const Fixture = () => <div onClick={(event) => event.stopPropagation()}>
    <Input onChange={(event) => setCredential(event.target.value)} />
    <Select onValueChange={setProvider}><SelectTrigger /><SelectItem value="x" /></Select>
  </div>;
`;
const file = 'fixture.tsx';
const sites = scanControls(source, file);
const key = (needle: string) => sites.find((site) => site.text.includes(needle))!;
const ref = (site: (typeof sites)[number]) => ({
  file,
  sourceHash: `sha256:${site.sourceHash}`,
  siteCount: 1,
});
const action = (id: string, refs: ReturnType<typeof ref>[]): SemanticRow => ({
  id,
  owner: 'runtime-provider-management',
  disposition: 'direct',
  securityClass: 'provider-credential',
  target: 'WP-4',
  evidence: ['fixture'],
  sourceRefs: refs,
});

describe('Phase 0 W1 semantic scanner', () => {
  it('maps event containment to absence and a multi-part Select to one semantic action', () => {
    const selectRefs = sites.filter((site) => site.element.startsWith('Select')).map(ref);
    expect(() =>
      validateSemanticCatalog(
        sites,
        [
          action('provider.management.credentials.edit', [ref(key('setCredential'))]),
          action('provider.management.select', selectRefs),
        ],
        [
          {
            id: 'P0.W1.ABSENCE.event-containment',
            reason: 'not an action',
            sourceRefs: [ref(key('stopPropagation'))],
          },
        ]
      )
    ).not.toThrow();
  });

  it('discovers omitted event families and capture variants', () => {
    const eventSites = scanControls(
      `<div
        onBlur={saveOnBlur}
        onPaste={addPastedFiles}
        onContextMenu={openContextMenu}
        onDragStart={beginDrag}
        onClickCapture={openTaskLink}
      />`,
      file
    );

    expect(eventSites.map((site) => site.prop)).toEqual([
      'onBlur',
      'onPaste',
      'onContextMenu',
      'onDragStart',
      'onClickCapture',
    ]);
  });

  it('recognizes every React DOM event property in the pinned type surface', () => {
    const reactTypes = readFileSync(
      join(process.cwd(), 'node_modules/@types/react/index.d.ts'),
      'utf8'
    );
    const domAttributes = reactTypes.slice(
      reactTypes.indexOf('interface DOMAttributes<T>'),
      reactTypes.indexOf('interface HTMLAttributes<T>')
    );
    const eventProps = [...domAttributes.matchAll(/^\s+(on[A-Z][A-Za-z]+)\??:/gm)].map(
      (match) => match[1]
    );

    expect(eventProps.length).toBeGreaterThan(100);
    expect(eventProps.filter((prop) => !isEventProp(prop))).toEqual([]);
  });

  it('discovers external-package callbacks without extending the React event allowlist', () => {
    const eventSites = scanControls(
      `import { DndContext } from '@dnd-kit/core';
       import { Sheet } from 'react-modal-sheet';
       <><DndContext onDragCancel={cancelDrag} /><Sheet onClose={close} onSnap={snap} /></>`,
      file
    );

    expect(eventSites.map(({ element, prop }) => `${element}.${prop}`)).toEqual([
      'DndContext.onDragCancel',
      'Sheet.onClose',
      'Sheet.onSnap',
    ]);
  });

  it('rejects omission of any discovered event family', () => {
    const eventSites = scanControls(
      '<div onBlur={saveOnBlur} onPaste={addPastedFiles} onContextMenu={openContextMenu} onDragStart={beginDrag} />',
      file
    );
    expect(() =>
      validateSemanticCatalog(
        eventSites,
        [action('team.task.save-on-blur', eventSites.slice(0, 3).map(ref))],
        []
      )
    ).toThrow(/Missing or stale semantic mapping/);
  });

  it('rejects assigning a mixed containment and semantic handler to absence', () => {
    const [mixedSite] = scanControls(
      '<Input onKeyDown={(event) => { event.stopPropagation(); saveSubject(); }} />',
      file
    );
    expect(mixedSite.effects).toEqual(['containment', 'semantic']);
    expect(() =>
      validateSemanticCatalog(
        [mixedSite],
        [],
        [
          {
            id: 'P0.W1.ABSENCE.event-containment',
            reason: 'not an action',
            sourceRefs: [ref(mixedSite)],
          },
        ]
      )
    ).toThrow(/Mixed containment\/semantic handler must map to a semantic action/);
    expect(() =>
      validateSemanticCatalog([mixedSite], [action('team.task.save-subject', [ref(mixedSite)])], [])
    ).not.toThrow();
  });

  it('rejects a missing semantic action mapping', () => {
    expect(() => validateSemanticCatalog(sites, [], [])).toThrow(/Missing or stale/);
  });

  it('rejects a duplicate semantic assignment', () => {
    const credential = ref(key('setCredential'));
    expect(() =>
      validateSemanticCatalog(
        [key('setCredential')],
        [
          action('provider.management.credentials.edit', [credential]),
          action('provider.management.credentials.replace', [credential]),
        ],
        []
      )
    ).toThrow(/assigned twice/);
  });

  it('keeps semantic IDs stable when unrelated lines are inserted', () => {
    const shifted = scanControls(`\n\n// unrelated\n${source}`, file);
    expect(shifted.map((site) => site.sourceHash)).toEqual(sites.map((site) => site.sourceHash));
    expect(action('provider.management.credentials.edit', []).id).toBe(
      'provider.management.credentials.edit'
    );
  });

  it('keeps an explicit child action ID stable across unrelated line shifts', () => {
    const childFile = 'fixture/ImmediateChild.tsx';
    const childSource =
      'export const ImmediateChild = () => <button onClick={handleRefresh}>Refresh</button>;';
    const childSite = scanControls(childSource, childFile)[0];
    const actionId = 'team.legacy-control.immediate-child.refresh';
    const catalog: ChildControlCatalog = {
      schemaId: 'fixture',
      schemaVersion: 2,
      evidenceId: 'fixture',
      packetRevision: 'phase-00-r2',
      pinnedBaseSha: 'fixture',
      phaseStartSha: 'fixture',
      roots: [childFile],
      sourceFiles: [childFile],
      actions: {
        [actionId]: 'team-console|direct|renderer-local|WP-7-TEAM-CONSOLE|fixture',
      },
      absences: {},
      mappings: {
        [`${childFile}#sha256:${childSite.sourceHash}`]: `1|${actionId}`,
      },
    };
    expect(() => validateChildControlCatalog([childSite], catalog)).not.toThrow();
    expect(() =>
      validateChildControlCatalog(
        scanControls(`\n// unrelated\n${childSource}`, childFile),
        catalog
      )
    ).not.toThrow();
  });

  it('rejects omission of a reachable immediate child and its real control mapping', () => {
    const root = process.cwd();
    const readSource = (file: string): string | undefined => {
      const absolute = join(root, file);
      return existsSync(absolute) && statSync(absolute).isFile()
        ? readFileSync(absolute, 'utf8')
        : undefined;
    };
    const discovered = discoverControlClosure(CONTROL_ROOTS, readSource);
    const catalog = JSON.parse(
      readFileSync(
        join(
          root,
          'docs/research/hosted-web/phase-0/parity-renderer/renderer-child-control-catalog.json'
        ),
        'utf8'
      )
    ) as ChildControlCatalog;
    const omittedFile = 'src/renderer/components/team/TeamListFilterPopover.tsx';
    expect(() =>
      validateControlClosure(
        discovered,
        catalog.sourceFiles.filter((file) => file !== omittedFile)
      )
    ).toThrow(/TeamListFilterPopover/);

    const sites = discovered.flatMap((file) => scanControls(readSource(file)!, file));
    const omittedMapping = Object.keys(catalog.mappings).find((key) =>
      key.startsWith(`${omittedFile}#`)
    )!;
    const mappings = { ...catalog.mappings };
    delete mappings[omittedMapping];
    expect(() => validateChildControlCatalog(sites, { ...catalog, mappings })).toThrow(
      /Missing child control mapping.*TeamListFilterPopover/
    );
  });

  it('maps the repository omitted-family sites and both task-subject save paths', () => {
    const root = process.cwd();
    const catalog = JSON.parse(
      readFileSync(
        join(
          root,
          'docs/research/hosted-web/phase-0/parity-renderer/renderer-child-control-catalog.json'
        ),
        'utf8'
      )
    ) as ChildControlCatalog;
    const cases = [
      ['src/renderer/components/team/messages/MessageComposer.tsx', 'onPaste'],
      ['src/renderer/components/team/editor/EditorContextMenu.tsx', 'onContextMenu'],
      ['src/renderer/components/team/editor/EditorFileTree.tsx', 'onDragStart'],
    ] as const;
    for (const [sourceFile, prop] of cases) {
      const [site] = scanControls(readFileSync(join(root, sourceFile), 'utf8'), sourceFile).filter(
        (candidate) => candidate.prop === prop
      );
      expect(site).toBeDefined();
      expect(catalog.mappings[`${sourceFile}#sha256:${site.sourceHash}`]).toMatch(/^1\|team\./);
    }

    const taskFile = 'src/renderer/components/team/dialogs/TaskDetailDialog.tsx';
    const subjectSaveSites = scanControls(
      readFileSync(join(root, taskFile), 'utf8'),
      taskFile
    ).filter((site) => site.text.includes('saveSubject'));
    expect(subjectSaveSites.map((site) => site.prop)).toEqual(['onKeyDown', 'onBlur']);
    expect(
      subjectSaveSites.map((site) => catalog.mappings[`${taskFile}#sha256:${site.sourceHash}`])
    ).toEqual([
      '1|team.legacy-control.dialogs.task.detail.dialog.save-subject',
      '1|team.legacy-control.dialogs.task.detail.dialog.save-subject',
    ]);
  });

  it('maps every mounted external interaction callback found in the repository closure', () => {
    const cases = [
      ['src/renderer/components/team/editor/EditorFileTree.tsx', 'DndContext', 'onDragCancel'],
      ['src/renderer/components/team/editor/EditorTabBar.tsx', 'DndContext', 'onDragCancel'],
      ['src/renderer/components/team/messages/MessagesPanel.tsx', 'Sheet', 'onClose'],
      ['src/renderer/components/team/messages/MessagesPanel.tsx', 'Sheet', 'onSnap'],
    ] as const;
    const catalog = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          'docs/research/hosted-web/phase-0/parity-renderer/renderer-child-control-catalog.json'
        ),
        'utf8'
      )
    ) as ChildControlCatalog;

    for (const [sourceFile, element, prop] of cases) {
      const sites = scanControls(readFileSync(join(process.cwd(), sourceFile), 'utf8'), sourceFile);
      const site = sites.find(
        (candidate) => candidate.element === element && candidate.prop === prop
      );
      expect(site, `${sourceFile} ${element}.${prop}`).toBeDefined();
      expect(catalog.mappings[`${sourceFile}#sha256:${site!.sourceHash}`]).toBeDefined();
    }
  });

  it.each([
    [
      'src/renderer/components/team/editor/EditorFileTree.tsx',
      'onDragCancel={handleDragCancel}',
      'DndContext.onDragCancel',
    ],
    [
      'src/renderer/components/team/messages/MessagesPanel.tsx',
      'onClose={moveToInline}',
      'Sheet.onClose',
    ],
    [
      'src/renderer/components/team/messages/MessagesPanel.tsx',
      'onSnap={setBottomSheetSnapIndex}',
      'Sheet.onSnap',
    ],
  ])(
    'rejects repository evidence when %s omits %s (%s)',
    (omittedFile, omittedSource, _callback) => {
      const root = process.cwd();
      const readSource = (sourceFile: string): string | undefined => {
        const absolute = join(root, sourceFile);
        if (!existsSync(absolute) || !statSync(absolute).isFile()) return undefined;
        const source = readFileSync(absolute, 'utf8');
        return sourceFile === omittedFile ? source.replace(omittedSource, '') : source;
      };
      const catalog = JSON.parse(
        readFileSync(
          join(
            root,
            'docs/research/hosted-web/phase-0/parity-renderer/renderer-child-control-catalog.json'
          ),
          'utf8'
        )
      ) as ChildControlCatalog;
      const sites = discoverControlClosure(CONTROL_ROOTS, readSource).flatMap((sourceFile) =>
        scanControls(readSource(sourceFile)!, sourceFile)
      );

      expect(() => validateChildControlCatalog(sites, catalog)).toThrow(
        new RegExp(`Child control reference is stale: ${omittedFile}`)
      );
    }
  );

  it('includes every separately mounted approval/global-task control and all 29 sites', () => {
    const root = process.cwd();
    const readSource = (sourceFile: string): string | undefined => {
      const absolute = join(root, sourceFile);
      return existsSync(absolute) && statSync(absolute).isFile()
        ? readFileSync(absolute, 'utf8')
        : undefined;
    };
    const mountedFiles = [
      'src/renderer/components/team/ToolApprovalSheet.tsx',
      'src/renderer/components/team/ToolApprovalDiffPreview.tsx',
      'src/renderer/components/team/dialogs/ToolApprovalSettingsPanel.tsx',
      'src/renderer/components/team/dialogs/GlobalTaskDetailDialog.tsx',
    ];
    const discovered = discoverControlClosure(CONTROL_ROOTS, readSource);
    expect(validateMountedControlRoots(readSource)).toEqual([
      {
        root: 'src/renderer/components/team/ToolApprovalSheet.tsx',
        mountChain: ['src/renderer/App.tsx#ToolApprovalSheet'],
      },
      {
        root: 'src/renderer/components/team/dialogs/GlobalTaskDetailDialog.tsx',
        mountChain: [
          'src/renderer/components/layout/TabbedLayout.tsx#GlobalTaskDetailDialogSlot',
          'src/renderer/components/layout/GlobalTaskDetailDialogSlot.tsx#GlobalTaskDetailDialog',
        ],
      },
    ]);
    expect(() =>
      validateMountedControlRoots((sourceFile) => {
        const contents = readSource(sourceFile);
        return sourceFile === 'src/renderer/App.tsx'
          ? contents?.replace('<ToolApprovalSheet />', '')
          : contents;
      })
    ).toThrow(/Mounted control root is not reachable/);
    expect(mountedFiles.every((sourceFile) => discovered.includes(sourceFile))).toBe(true);
    expect(
      Object.fromEntries(
        mountedFiles.map((sourceFile) => [
          sourceFile,
          scanControls(readSource(sourceFile)!, sourceFile).length,
        ])
      )
    ).toEqual({
      'src/renderer/components/team/ToolApprovalSheet.tsx': 11,
      'src/renderer/components/team/ToolApprovalDiffPreview.tsx': 3,
      'src/renderer/components/team/dialogs/ToolApprovalSettingsPanel.tsx': 14,
      'src/renderer/components/team/dialogs/GlobalTaskDetailDialog.tsx': 1,
    });
  });

  it('maps API-linked legacy child IDs to canonical API action owners', () => {
    const root = process.cwd();
    const catalog = JSON.parse(
      readFileSync(
        join(
          root,
          'docs/research/hosted-web/phase-0/parity-renderer/renderer-child-control-catalog.json'
        ),
        'utf8'
      )
    ) as ChildControlCatalog;
    const apiLedger = JSON.parse(
      readFileSync(
        join(root, 'docs/research/hosted-web/phase-0/parity-renderer/api-parity-ledger.json'),
        'utf8'
      )
    ) as { members: Array<{ actionId: string; owningFeature: string }> };
    const linkedChildActions = Object.keys(LEGACY_CHILD_API_ACTION_IDS).map((id) => {
      const [owner, disposition, securityClass, target, ...evidence] =
        catalog.actions[id].split('|');
      return {
        id,
        owner,
        disposition: disposition as SemanticRow['disposition'],
        securityClass,
        target,
        evidence,
        sourceRefs: [],
      };
    });

    expect(validateLegacyChildApiActionMappings(linkedChildActions, apiLedger.members)).toEqual([
      {
        childActionId: 'team.legacy-control.dialogs.add.member.dialog.handle-submit',
        apiActionId: 'team.lifecycle.add-member',
        owner: 'team-lifecycle',
      },
      {
        childActionId: 'team.legacy-control.members.member.card.handle-restart-member',
        apiActionId: 'team.lifecycle.restart-member',
        owner: 'team-lifecycle',
      },
      {
        childActionId: 'team.legacy-control.members.member.card.handle-restore-member',
        apiActionId: 'team.lifecycle.restore-member',
        owner: 'team-lifecycle',
      },
    ]);
    expect(() =>
      validateLegacyChildApiActionMappings(
        linkedChildActions.map((row, index) =>
          index === 0 ? { ...row, owner: 'team-runtime-control' } : row
        ),
        apiLedger.members
      )
    ).toThrow(/Child\/API ownership conflict/);
    expect(() =>
      validateLegacyChildApiActionMappings(linkedChildActions.slice(1), apiLedger.members)
    ).toThrow(/Missing API-linked child action/);
  });

  it('fails an unannotated dynamic dispatch and accepts an annotation', () => {
    expect(findDynamicDispatch('api.teams[name]()')).toEqual(['api.teams[name]']);
    expect(
      findDynamicDispatch('// @hosted-web-dynamic-action team.lifecycle.stop\napi.teams[name]()')
    ).toEqual([]);
  });

  it('rejects missing and duplicate API member dispositions', () => {
    const api = scanApiInterfaces(
      'interface TeamsAPI { stop(): Promise<void>; list(): Promise<void> } interface ReviewAPI {} interface CrossTeamAPI {}'
    );
    expect(() =>
      validateApiDispositions(api, [{ source: 'TeamsAPI', sourceMember: 'stop' }])
    ).toThrow(/exactly once/);
    expect(() =>
      validateApiDispositions(api, [
        { source: 'TeamsAPI', sourceMember: 'stop' },
        { source: 'TeamsAPI', sourceMember: 'stop' },
      ])
    ).toThrow(/exactly once/);
    expect(() =>
      validateApiDispositions(api, [
        { source: 'TeamsAPI', sourceMember: 'list' },
        { source: 'TeamsAPI', sourceMember: 'stop' },
      ])
    ).not.toThrow();
  });

  it('validates nested schema requirements and rejects a missing acceptance field', () => {
    const schema = {
      type: 'object',
      required: ['actions'],
      properties: { actions: { type: 'array', items: { type: 'object', required: ['owner'] } } },
    };
    expect(() =>
      validateJsonSchema({ actions: [{ owner: 'team-lifecycle' }] }, schema)
    ).not.toThrow();
    expect(() => validateJsonSchema({ actions: [{}] }, schema)).toThrow(/owner is required/);
  });
});
