import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  AddTaskCommentRequest as PortAddTaskCommentRequest,
  ApplicationCommandRequestIdentity as PortApplicationCommandRequestIdentity,
  CommentAttachmentPayload as PortCommentAttachmentPayload,
  CreateTaskRequest as PortCreateTaskRequest,
  GlobalTask as PortGlobalTask,
  KanbanColumnId as PortKanbanColumnId,
  TaskChangePresenceState as PortTaskChangePresenceState,
  TaskComment as PortTaskComment,
  TaskCommentType as PortTaskCommentType,
  TaskRef as PortTaskRef,
  TeamTask as PortTeamTask,
  TeamTaskStatus as PortTeamTaskStatus,
  TeamTaskWithKanban as PortTeamTaskWithKanban,
  UpdateKanbanPatch as PortUpdateKanbanPatch,
} from '@features/team-task-board/core/application/models/TeamTaskBoardPortModels';
import type {
  AddTaskCommentRequest as SharedAddTaskCommentRequest,
  ApplicationCommandRequestIdentity as SharedApplicationCommandRequestIdentity,
  CommentAttachmentPayload as SharedCommentAttachmentPayload,
  CreateTaskRequest as SharedCreateTaskRequest,
  GlobalTask as SharedGlobalTask,
  KanbanColumnId as SharedKanbanColumnId,
  TaskChangePresenceState as SharedTaskChangePresenceState,
  TaskComment as SharedTaskComment,
  TaskCommentType as SharedTaskCommentType,
  TaskRef as SharedTaskRef,
  TeamTask as SharedTeamTask,
  TeamTaskStatus as SharedTeamTaskStatus,
  TeamTaskWithKanban as SharedTeamTaskWithKanban,
  UpdateKanbanPatch as SharedUpdateKanbanPatch,
} from '@shared/types';

type DeclarationKind =
  | 'class'
  | 'enum'
  | 'function'
  | 'interface'
  | 'namespace'
  | 'type'
  | 'variable';

interface Declaration {
  readonly exportLabel: 'export-only' | 'unexpected-modifiers';
  readonly kind: DeclarationKind;
  readonly name: string;
}

interface ParsedModule {
  readonly name: string;
  readonly sourceFile: ts.SourceFile;
}

const PORTS_DIRECTORY = resolve(
  process.cwd(),
  'src/features/team-task-board/core/application/ports'
);
const APPLICATION_MODEL_PATH = resolve(
  process.cwd(),
  'src/features/team-task-board/core/application/models/TeamTaskBoardPortModels.ts'
);
const FACADE_MODULE = 'TeamTaskBoardPorts.ts';
const PORT_MODELS_MODULE = 'TeamTaskBoardPortModels.ts';
const FORBIDDEN_PORT_DTO_MODULES = ['@shared/types', '../../../contracts/taskBoard'] as const;
const SAFE_ATTACHMENT_CONTRACT_MODULE = '../../../contracts/taskAttachments';

const CAPABILITY_HOMES = {
  'TeamTaskAttachmentPorts.ts': [
    ['interface', 'PreparedTaskAttachmentDeletion'],
    ['interface', 'SavedTaskAttachment'],
    ['interface', 'TaskAttachmentMetadataPort'],
    ['interface', 'TaskAttachmentStoragePort'],
    ['interface', 'TaskAttachmentStorageTransactionPort'],
  ],
  'TeamTaskBoardMutationPorts.ts': [
    ['type', 'TaskClarificationValue'],
    ['interface', 'TaskFields'],
    ['interface', 'TaskFieldsWriterPort'],
    ['type', 'TaskRelationshipType'],
    ['interface', 'TeamTaskBoardCommandPort'],
  ],
  'TeamTaskBoardSupportPorts.ts': [
    ['interface', 'ClockPort'],
    ['interface', 'GlobalTaskQueryPort'],
    ['interface', 'MainOperationTrackerPort'],
    ['interface', 'TaskChangePresencePort'],
    ['interface', 'TeamLeadNotificationPort'],
    ['interface', 'TeamRuntimeStatusPort'],
    ['interface', 'TeamTaskBoardLoggerPort'],
    ['interface', 'TeamTaskBoardQueryPort'],
  ],
  'TeamTaskCommentPorts.ts': [
    ['interface', 'SavedTaskCommentAttachment'],
    ['interface', 'TaskCommentAttachmentTransactionPort'],
    ['interface', 'TaskCommentAttachmentWriterPort'],
    ['type', 'TaskCommentRequest'],
    ['interface', 'TaskCommentWriterPort'],
  ],
} as const satisfies Readonly<Record<string, readonly (readonly [DeclarationKind, string])[]>>;

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort(compareText);
}

function parseTypeScriptModule(name: string, path: string): ParsedModule {
  return {
    name,
    sourceFile: ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    ),
  };
}

function parseModule(name: string): ParsedModule {
  return parseTypeScriptModule(name, join(PORTS_DIRECTORY, name));
}

function loadPortModules(): ParsedModule[] {
  return readdirSync(PORTS_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => parseModule(entry.name));
}

function exportLabelOf(statement: ts.Statement): Declaration['exportLabel'] {
  if (!ts.canHaveModifiers(statement)) return 'unexpected-modifiers';
  const modifiers = ts.getModifiers(statement) ?? [];
  return modifiers.length === 1 && modifiers[0].kind === ts.SyntaxKind.ExportKeyword
    ? 'export-only'
    : 'unexpected-modifiers';
}

function namedDeclarationOf(statement: ts.Statement): Declaration | null {
  const exportLabel = exportLabelOf(statement);
  if (ts.isInterfaceDeclaration(statement)) {
    return { exportLabel, kind: 'interface', name: statement.name.text };
  }
  if (ts.isTypeAliasDeclaration(statement)) {
    return { exportLabel, kind: 'type', name: statement.name.text };
  }
  if (ts.isClassDeclaration(statement) && statement.name) {
    return { exportLabel, kind: 'class', name: statement.name.text };
  }
  if (ts.isEnumDeclaration(statement)) {
    return { exportLabel, kind: 'enum', name: statement.name.text };
  }
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    return { exportLabel, kind: 'function', name: statement.name.text };
  }
  if (ts.isModuleDeclaration(statement)) {
    return { exportLabel, kind: 'namespace', name: statement.name.text };
  }
  return null;
}

function declarationsIn(module: ParsedModule): Declaration[] {
  return module.sourceFile.statements.flatMap((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.map((declaration) => ({
        exportLabel: exportLabelOf(statement),
        kind: 'variable' as const,
        name: declaration.name.getText(module.sourceFile),
      }));
    }

    const declaration = namedDeclarationOf(statement);
    return declaration ? [declaration] : [];
  });
}

function moduleSpecifierOf(statement: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
  return statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
    ? statement.moduleSpecifier.text
    : null;
}

function facadeLabels(statement: ts.Statement): string[] {
  if (!ts.isExportDeclaration(statement)) return ['<non-export statement>'];

  const source = moduleSpecifierOf(statement) ?? '<missing module>';
  if (!statement.isTypeOnly) return [`<value export from ${source}>`];
  if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
    return [`<non-named export from ${source}>`];
  }
  if (statement.exportClause.elements.length === 0) {
    return [`<empty export from ${source}>`];
  }

  return statement.exportClause.elements.map((element) => {
    if (element.propertyName) {
      return `<aliased export ${element.propertyName.text} as ${element.name.text} from ${source}>`;
    }
    if (element.isTypeOnly) {
      return `<element-level type export ${element.name.text} from ${source}>`;
    }
    return `${source}:${element.name.text}`;
  });
}

function findModule(modules: readonly ParsedModule[], name: string): ParsedModule {
  const module = modules.find((candidate) => candidate.name === name);
  if (!module) throw new Error(`Missing port module: ${name}`);
  return module;
}

const portModules = loadPortModules();
const applicationModel = parseTypeScriptModule(PORT_MODELS_MODULE, APPLICATION_MODEL_PATH);
const capabilityEntries = Object.entries(CAPABILITY_HOMES);
const protectedNames: ReadonlySet<string> = new Set(
  capabilityEntries.flatMap(([, declarations]) => declarations.map(([, name]) => name))
);

describe('Team Task Board capability port boundary', () => {
  it('keeps every protected declaration in its exact capability home', () => {
    const expectedLocations = capabilityEntries.flatMap(([moduleName, declarations]) =>
      declarations.map(([kind, name]) => `${moduleName}:export-only:${kind}:${name}`)
    );
    const actualLocations = portModules.flatMap((module) =>
      declarationsIn(module)
        .filter(({ name }) => protectedNames.has(name))
        .map(({ exportLabel, kind, name }) => `${module.name}:${exportLabel}:${kind}:${name}`)
    );

    expect(sorted(actualLocations)).toEqual(sorted(expectedLocations));

    for (const [moduleName, declarations] of capabilityEntries) {
      const actualDeclarations = declarationsIn(findModule(portModules, moduleName)).map(
        ({ exportLabel, kind, name }) => `${exportLabel}:${kind}:${name}`
      );
      const expectedDeclarations = declarations.map(
        ([kind, name]) => `export-only:${kind}:${name}`
      );
      expect(sorted(actualDeclarations), moduleName).toEqual(sorted(expectedDeclarations));
    }
  });

  it('keeps the compatibility facade as the exact named type-only export surface', () => {
    const expectedExports = capabilityEntries.flatMap(([moduleName, declarations]) => {
      const source = `./${moduleName.slice(0, -3)}`;
      return declarations.map(([, name]) => `${source}:${name}`);
    });
    const actualExports = findModule(portModules, FACADE_MODULE).sourceFile.statements.flatMap(
      facadeLabels
    );

    expect(sorted(actualExports)).toEqual(sorted(expectedExports));
  });

  it.each(Object.keys(CAPABILITY_HOMES))(
    'keeps forbidden shared and task-board contract DTO modules out of %s',
    (moduleName) => {
      const dependencySources = findModule(portModules, moduleName).sourceFile.statements.flatMap(
        (statement) => {
          if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return [];
          return [moduleSpecifierOf(statement) ?? '<missing module>'];
        }
      );

      expect(
        dependencySources.filter((source) =>
          FORBIDDEN_PORT_DTO_MODULES.some(
            (forbidden) => source === forbidden || source.startsWith(`${forbidden}/`)
          )
        )
      ).toEqual([]);
    }
  );

  it('keeps the application port model on its one safe attachment contract dependency', () => {
    const dependencyStatements = applicationModel.sourceFile.statements.filter((statement) => {
      return ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement);
    });

    expect(
      dependencyStatements.map((statement) => moduleSpecifierOf(statement) ?? '<missing module>')
    ).toEqual([SAFE_ATTACHMENT_CONTRACT_MODULE]);

    const attachmentImport = dependencyStatements[0];
    if (!attachmentImport || !ts.isImportDeclaration(attachmentImport)) {
      throw new Error(`${PORT_MODELS_MODULE} must have one type-only attachment import`);
    }
    if (
      attachmentImport.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword ||
      !attachmentImport.importClause.namedBindings ||
      !ts.isNamedImports(attachmentImport.importClause.namedBindings)
    ) {
      throw new Error(`${PORT_MODELS_MODULE} must use one named type-only attachment import`);
    }

    expect(attachmentImport.importClause.name).toBeUndefined();
    expect(
      attachmentImport.importClause.namedBindings.elements.map((element) =>
        element.propertyName
          ? `${element.propertyName.text} as ${element.name.text}`
          : element.name.text
      )
    ).toEqual(['AttachmentMediaType', 'TaskAttachmentMeta']);
  });

  it('keeps local port DTO projections bidirectionally compatible with shared DTOs', () => {
    expectTypeOf<PortTeamTaskStatus>().toExtend<SharedTeamTaskStatus>();
    expectTypeOf<SharedTeamTaskStatus>().toExtend<PortTeamTaskStatus>();
    expectTypeOf<PortTaskRef>().toExtend<SharedTaskRef>();
    expectTypeOf<SharedTaskRef>().toExtend<PortTaskRef>();
    expectTypeOf<PortApplicationCommandRequestIdentity>().toExtend<SharedApplicationCommandRequestIdentity>();
    expectTypeOf<SharedApplicationCommandRequestIdentity>().toExtend<PortApplicationCommandRequestIdentity>();
    expectTypeOf<PortCreateTaskRequest>().toExtend<SharedCreateTaskRequest>();
    expectTypeOf<SharedCreateTaskRequest>().toExtend<PortCreateTaskRequest>();
    expectTypeOf<PortKanbanColumnId>().toExtend<SharedKanbanColumnId>();
    expectTypeOf<SharedKanbanColumnId>().toExtend<PortKanbanColumnId>();
    expectTypeOf<PortUpdateKanbanPatch>().toExtend<SharedUpdateKanbanPatch>();
    expectTypeOf<SharedUpdateKanbanPatch>().toExtend<PortUpdateKanbanPatch>();
    expectTypeOf<PortTaskChangePresenceState>().toExtend<SharedTaskChangePresenceState>();
    expectTypeOf<SharedTaskChangePresenceState>().toExtend<PortTaskChangePresenceState>();
    expectTypeOf<PortTeamTask>().toExtend<SharedTeamTask>();
    expectTypeOf<SharedTeamTask>().toExtend<PortTeamTask>();
    expectTypeOf<PortTeamTaskWithKanban>().toExtend<SharedTeamTaskWithKanban>();
    expectTypeOf<SharedTeamTaskWithKanban>().toExtend<PortTeamTaskWithKanban>();
    expectTypeOf<PortGlobalTask>().toExtend<SharedGlobalTask>();
    expectTypeOf<SharedGlobalTask>().toExtend<PortGlobalTask>();
    expectTypeOf<PortTaskCommentType>().toExtend<SharedTaskCommentType>();
    expectTypeOf<SharedTaskCommentType>().toExtend<PortTaskCommentType>();
    expectTypeOf<PortCommentAttachmentPayload>().toExtend<SharedCommentAttachmentPayload>();
    expectTypeOf<SharedCommentAttachmentPayload>().toExtend<PortCommentAttachmentPayload>();
    expectTypeOf<PortTaskComment>().toExtend<SharedTaskComment>();
    expectTypeOf<SharedTaskComment>().toExtend<PortTaskComment>();
    expectTypeOf<PortAddTaskCommentRequest>().toExtend<SharedAddTaskCommentRequest>();
    expectTypeOf<SharedAddTaskCommentRequest>().toExtend<PortAddTaskCommentRequest>();
  });
});
