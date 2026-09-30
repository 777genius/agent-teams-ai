import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const portPath = 'src/features/team-approvals/renderer/ports/HostedTeamApprovalRendererPorts.ts';
const slicePath =
  'src/features/team-approvals/renderer/slices/createHostedTeamApprovalRendererSlice.ts';
const panelPath = 'src/features/team-approvals/renderer/components/HostedTeamApprovalPanel.tsx';
const rendererEntryPath = 'src/features/team-approvals/renderer/index.ts';
const rootEntryPath = 'src/features/team-approvals/index.ts';
const rendererTestPaths = [
  'test/features/team-approvals/renderer/HostedTeamApprovalRendererSlice.test.ts',
  'test/features/team-approvals/renderer/HostedTeamApprovalPanel.test.tsx',
] as const;
const productionPaths = [portPath, slicePath, panelPath, rendererEntryPath] as const;

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source(path),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function hasNodeText(path: string, expected: string): boolean {
  const parsed = sourceFile(path);
  const compactExpected = expected.replace(/\s+/g, '');
  let found = false;
  const visit = (node: ts.Node): void => {
    if (node.getText(parsed).replace(/\s+/g, '') === compactExpected) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

function jsxNames(path: string): { readonly attributes: string[]; readonly tags: string[] } {
  const parsed = sourceFile(path);
  const attributes: string[] = [];
  const tags: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      tags.push(node.tagName.getText(parsed));
    }
    if (ts.isJsxAttribute(node)) attributes.push(node.name.getText(parsed));
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return { attributes, tags };
}

describe('Phase 9 hosted team approval renderer boundary', () => {
  it('keeps the renderer slice on the injected hosted transport and browser-safe contracts', () => {
    const ports = source(portPath);
    const slice = source(slicePath);
    const panel = source(panelPath);
    const implementation = [ports, slice, panel].join('\n');

    expect(ports).toContain('readonly transport: HostedTeamApprovalTransport;');
    expect(ports).toContain('HostedTeamApprovalRendererRefreshPort');
    expect(ports).toContain('HostedTeamApprovalRendererReconnectPort');
    expect(slice).toContain('dependencies.transport.getPage(');
    expect(slice).toContain('dependencies.transport.getPreview(');
    expect(slice).toContain('dependencies.transport.decide(');
    expect(implementation).not.toMatch(
      /@renderer\/api|\bapi\.teams\b|electronAPI|ElectronAPI|@main\/|src\/main|legacy|child_process|\bfetch\s*\(|window\./i
    );
  });

  it('owns independent monotonic fences and applies focus only through fenced state', () => {
    const slice = source(slicePath);

    expect(slice).toContain('let pageGeneration = 0;');
    expect(slice).toContain('let previewGeneration = 0;');
    expect(slice).toContain('let decisionGeneration = 0;');
    expect(slice).toContain('const isCurrentPage');
    expect(slice).toContain('const isCurrentPreview');
    expect(slice).toContain('const isCurrentDecision');
    expect(slice).toContain('if (!isCurrentPage(generation)) return;');
    expect(slice).toContain('if (!isCurrentPreview(generation, item)) return;');
    expect(slice).toContain('if (!isCurrentDecision(generation, item)) return;');
    expect(hasNodeText(slicePath, 'pendingDecision?.approvalId === item.approvalId')).toBe(true);
    expect(hasNodeText(slicePath, 'pendingDecision.generation === item.generation')).toBe(true);
    expect(hasNodeText(slicePath, 'pendingDecision.decision === decision')).toBe(true);
    expect(slice).toContain('decisionReceipt: result.receipt');
    expect(slice).not.toMatch(/items:\s*state\.items\.filter|optimistic/i);
  });

  it('uses shared Radix-backed controls with explicit accessible names and no native tooltip', () => {
    const panel = source(panelPath);
    const panelJsx = jsxNames(panelPath);

    expect(panel).toContain("from '@renderer/components/ui/button'");
    expect(panel).toContain("from '@renderer/components/ui/tooltip'");
    expect(panel).toContain('<TooltipTrigger asChild>');
    expect(panel).toContain('aria-label="Refresh approvals"');
    expect(panel).toContain('aria-live="polite"');
    expect(panel).toContain('useLayoutEffect');
    expect(panelJsx.tags).not.toContain('button');
    expect(panelJsx.attributes).not.toContain('title');
  });

  it('publishes the renderer surface only through the renderer entrypoint', () => {
    const rendererEntry = source(rendererEntryPath);
    const rootEntry = source(rootEntryPath);

    expect(rendererEntry).toContain('HostedTeamApprovalPanel');
    expect(rendererEntry).toContain('createHostedTeamApprovalRendererSlice');
    expect(rendererEntry).toContain('HostedTeamApprovalRendererSliceDependencies');
    expect(rootEntry).not.toMatch(
      /HostedTeamApprovalPanel|createHostedTeamApprovalRendererSlice|HostedTeamApprovalRenderer/
    );
    for (const path of rendererTestPaths) {
      expect(source(path), path).not.toMatch(
        /@features\/team-approvals\/renderer\/(?:ports|slices|components|composition)\//
      );
    }
  });

  it('keeps every owned production file below the source-size ceiling', () => {
    for (const path of productionPaths) {
      expect(source(path).split(/\r?\n/).length, path).toBeLessThanOrEqual(800);
    }
  });
});
