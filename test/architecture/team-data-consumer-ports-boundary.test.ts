import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ORGANIZATIONS_PORT_PATH =
  'src/features/organizations/main/application/OrganizationsTeamDataPort.ts';
const ORGANIZATIONS_ADAPTER_PATH =
  'src/features/organizations/main/adapters/output/TeamDirectoryOrganizationAdapter.ts';
const ORGANIZATIONS_COMPOSITION_PATH =
  'src/features/organizations/main/composition/createOrganizationsFeature.ts';
const ORGANIZATIONS_COMPOSITION_ENTRYPOINT_PATH = 'src/features/organizations/main/composition.ts';
const ORGANIZATIONS_MAIN_ENTRYPOINT_PATH = 'src/features/organizations/main/index.ts';
const TEAM_IMPORT_PORT_PATH = 'src/features/team-import/main/application/TeamImportTeamDataPort.ts';
const TEAM_IMPORT_REPOSITORY_PATH =
  'src/features/team-import/main/infrastructure/TeamDataImportDraftRepository.ts';
const TEAM_IMPORT_COMPOSITION_PATH =
  'src/features/team-import/main/composition/createTeamImportFeature.ts';
const TEAM_IMPORT_MAIN_ENTRYPOINT_PATH = 'src/features/team-import/main/index.ts';
const APP_COMPOSITION_PATH = 'src/main/index.ts';

function source(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed architecture test paths.
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function parse(path: string, contents: string): ts.SourceFile {
  return ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function declarationName(node: ts.NamedDeclaration): string | null {
  if (!node.name) return null;
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
}

function interfaceMethodNames(
  contents: string,
  path: string,
  interfaceName: string
): readonly string[] | null {
  const declaration = parse(path, contents).statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName
  );
  if (!declaration) return null;
  return declaration.members
    .filter(ts.isMethodSignature)
    .map((member) => declarationName(member))
    .filter((name): name is string => name !== null);
}

function importsSymbol(contents: string, path: string, symbol: string): boolean {
  return parse(path, contents).statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      !!statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => (element.propertyName ?? element.name).text === symbol
      )
  );
}

function exportsSymbol(contents: string, path: string, symbol: string): boolean {
  return parse(path, contents).statements.some(
    (statement) =>
      ts.isExportDeclaration(statement) &&
      !!statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some((element) => element.name.text === symbol)
  );
}

function classConstructorDependsOnPort(
  contents: string,
  path: string,
  className: string,
  portName: string
): boolean {
  const declaration = parse(path, contents).statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === className
  );
  const constructor = declaration?.members.find(ts.isConstructorDeclaration);
  return !!constructor?.parameters.some(
    (parameter) =>
      !!parameter.type &&
      ts.isTypeReferenceNode(parameter.type) &&
      ts.isIdentifier(parameter.type.typeName) &&
      parameter.type.typeName.text === portName
  );
}

function functionParameterDependsOnPort(
  contents: string,
  path: string,
  functionName: string,
  portName: string
): boolean {
  const declaration = parse(path, contents).statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === functionName
  );
  return !!declaration?.parameters.some(
    (parameter) =>
      !!parameter.type &&
      ts.isTypeReferenceNode(parameter.type) &&
      ts.isIdentifier(parameter.type.typeName) &&
      parameter.type.typeName.text === portName
  );
}

function objectParameterPropertyDependsOnPort(
  contents: string,
  path: string,
  functionName: string,
  propertyName: string,
  portName: string
): boolean {
  const declaration = parse(path, contents).statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === functionName
  );
  const parameterType = declaration?.parameters[0]?.type;
  if (!parameterType || !ts.isTypeLiteralNode(parameterType)) return false;
  return parameterType.members.some(
    (member) =>
      ts.isPropertySignature(member) &&
      declarationName(member) === propertyName &&
      !!member.type &&
      ts.isTypeReferenceNode(member.type) &&
      ts.isIdentifier(member.type.typeName) &&
      member.type.typeName.text === portName
  );
}

function containsTeamDataServiceImport(contents: string, path: string): boolean {
  return parse(path, contents).statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.includes('TeamDataService')
  );
}

function callArgumentPropertyNames(
  contents: string,
  path: string,
  functionName: string,
  argumentIndex: number
): readonly string[] | null {
  let properties: readonly string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === functionName &&
      ts.isObjectLiteralExpression(node.arguments[argumentIndex])
    ) {
      properties = node.arguments[argumentIndex].properties
        .filter(ts.isPropertyAssignment)
        .map((property) => declarationName(property))
        .filter((name): name is string => name !== null);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(path, contents));
  return properties;
}

function callArgumentNestedObjectPropertyNames(
  contents: string,
  path: string,
  functionName: string,
  argumentIndex: number,
  propertyName: string
): readonly string[] | null {
  let properties: readonly string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === functionName &&
      ts.isObjectLiteralExpression(node.arguments[argumentIndex])
    ) {
      const property = node.arguments[argumentIndex].properties.find(
        (candidate): candidate is ts.PropertyAssignment =>
          ts.isPropertyAssignment(candidate) && declarationName(candidate) === propertyName
      );
      if (property && ts.isObjectLiteralExpression(property.initializer)) {
        properties = property.initializer.properties
          .map((candidate) => declarationName(candidate))
          .filter((name): name is string => name !== null);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(path, contents));
  return properties;
}

describe('TeamDataService feature consumer ports', () => {
  it('keeps organization and import consumers behind their exact narrow ports', () => {
    const organizationsPort = source(ORGANIZATIONS_PORT_PATH);
    const organizationsAdapter = source(ORGANIZATIONS_ADAPTER_PATH);
    const organizationsComposition = source(ORGANIZATIONS_COMPOSITION_PATH);
    const organizationsCompositionEntrypoint = source(ORGANIZATIONS_COMPOSITION_ENTRYPOINT_PATH);
    const organizationsEntrypoint = source(ORGANIZATIONS_MAIN_ENTRYPOINT_PATH);
    const teamImportPort = source(TEAM_IMPORT_PORT_PATH);
    const teamImportRepository = source(TEAM_IMPORT_REPOSITORY_PATH);
    const teamImportComposition = source(TEAM_IMPORT_COMPOSITION_PATH);
    const teamImportEntrypoint = source(TEAM_IMPORT_MAIN_ENTRYPOINT_PATH);
    const appComposition = source(APP_COMPOSITION_PATH);

    expect(
      interfaceMethodNames(organizationsPort, ORGANIZATIONS_PORT_PATH, 'OrganizationsTeamDataPort')
    ).toEqual(['listTeams', 'getAllTasks', 'listAliveProcessTeams']);
    expect(
      interfaceMethodNames(teamImportPort, TEAM_IMPORT_PORT_PATH, 'TeamImportTeamDataPort')
    ).toEqual(['createTeamConfig']);

    expect(
      exportsSymbol(
        organizationsEntrypoint,
        ORGANIZATIONS_MAIN_ENTRYPOINT_PATH,
        'OrganizationsTeamDataPort'
      )
    ).toBe(true);
    expect(
      exportsSymbol(
        organizationsEntrypoint,
        ORGANIZATIONS_MAIN_ENTRYPOINT_PATH,
        'createOrganizationsFeature'
      )
    ).toBe(false);
    expect(
      exportsSymbol(
        organizationsCompositionEntrypoint,
        ORGANIZATIONS_COMPOSITION_ENTRYPOINT_PATH,
        'createOrganizationsFeature'
      )
    ).toBe(true);
    expect(
      exportsSymbol(
        teamImportEntrypoint,
        TEAM_IMPORT_MAIN_ENTRYPOINT_PATH,
        'TeamImportTeamDataPort'
      )
    ).toBe(true);

    expect(
      importsSymbol(organizationsAdapter, ORGANIZATIONS_ADAPTER_PATH, 'OrganizationsTeamDataPort')
    ).toBe(true);
    expect(
      importsSymbol(
        organizationsComposition,
        ORGANIZATIONS_COMPOSITION_PATH,
        'OrganizationsTeamDataPort'
      )
    ).toBe(true);
    expect(
      importsSymbol(teamImportRepository, TEAM_IMPORT_REPOSITORY_PATH, 'TeamImportTeamDataPort')
    ).toBe(true);
    expect(
      importsSymbol(teamImportComposition, TEAM_IMPORT_COMPOSITION_PATH, 'TeamImportTeamDataPort')
    ).toBe(true);
    expect(containsTeamDataServiceImport(organizationsAdapter, ORGANIZATIONS_ADAPTER_PATH)).toBe(
      false
    );
    expect(
      containsTeamDataServiceImport(organizationsComposition, ORGANIZATIONS_COMPOSITION_PATH)
    ).toBe(false);
    expect(containsTeamDataServiceImport(teamImportRepository, TEAM_IMPORT_REPOSITORY_PATH)).toBe(
      false
    );
    expect(containsTeamDataServiceImport(teamImportComposition, TEAM_IMPORT_COMPOSITION_PATH)).toBe(
      false
    );

    expect(
      classConstructorDependsOnPort(
        organizationsAdapter,
        ORGANIZATIONS_ADAPTER_PATH,
        'TeamDirectoryOrganizationAdapter',
        'OrganizationsTeamDataPort'
      )
    ).toBe(true);
    expect(
      classConstructorDependsOnPort(
        teamImportRepository,
        TEAM_IMPORT_REPOSITORY_PATH,
        'TeamDataImportDraftRepository',
        'TeamImportTeamDataPort'
      )
    ).toBe(true);
    expect(
      objectParameterPropertyDependsOnPort(
        organizationsComposition,
        ORGANIZATIONS_COMPOSITION_PATH,
        'createOrganizationsFeature',
        'teamData',
        'OrganizationsTeamDataPort'
      )
    ).toBe(true);
    expect(
      functionParameterDependsOnPort(
        teamImportComposition,
        TEAM_IMPORT_COMPOSITION_PATH,
        'createTeamImportFeature',
        'TeamImportTeamDataPort'
      )
    ).toBe(true);

    expect(
      callArgumentPropertyNames(appComposition, APP_COMPOSITION_PATH, 'createTeamImportFeature', 0)
    ).toEqual(['createTeamConfig']);
    expect(
      callArgumentNestedObjectPropertyNames(
        appComposition,
        APP_COMPOSITION_PATH,
        'createOrganizationsFeature',
        0,
        'teamData'
      )
    ).toEqual(['listTeams', 'getAllTasks', 'listAliveProcessTeams']);
  });
});
