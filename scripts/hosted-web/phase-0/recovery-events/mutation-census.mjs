import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import ts from 'typescript';

const DISPOSITIONS = new Set(['required_hosted_v1_mutation', 'query', 'ephemeral', 'deferred']);

function sourceMethodForCatalog(row) {
  return row.id === 'CrossTeamAPI.send' ? 'crossTeam.send' : row.sourceMethod;
}

const W1_OWNERSHIP_INTERFACES = new Set(['TeamsAPI', 'CrossTeamAPI', 'ReviewAPI']);

export function verifyCrossLaneOwnerAgreement({ w1Ledger, manifest, catalog }) {
  const errors = [];
  const w1ById = new Map();
  for (const member of w1Ledger.members ?? []) {
    const id = `${member.source}.${member.sourceMember}`;
    if (w1ById.has(id)) errors.push(`duplicate W1 ownership row ${id}`);
    w1ById.set(id, member);
  }

  const commandsByMethod = new Map();
  for (const command of catalog.commands ?? []) {
    for (const sourceMethod of command.sourceMethods ?? []) {
      const commands = commandsByMethod.get(sourceMethod) ?? [];
      commands.push(command);
      commandsByMethod.set(sourceMethod, commands);
    }
  }

  const comparedRows = (manifest.rows ?? []).filter(
    (row) =>
      row.disposition === 'required_hosted_v1_mutation' &&
      W1_OWNERSHIP_INTERFACES.has(row.interfaceName)
  );
  let missingW1Rows = 0;
  let ownerMismatches = 0;
  for (const row of comparedRows) {
    const w1Member = w1ById.get(row.id);
    if (!w1Member) {
      missingW1Rows += 1;
      errors.push(`required W5 mutation missing W1 ownership row ${row.id}`);
      continue;
    }
    const commands = commandsByMethod.get(sourceMethodForCatalog(row)) ?? [];
    if (commands.length !== 1) {
      errors.push(`required W5 mutation lacks one catalog owner ${row.id}=${commands.length}`);
      continue;
    }
    const [command] = commands;
    let rowOwnerMismatch = false;
    if (row.owner !== w1Member.owningFeature) {
      rowOwnerMismatch = true;
      errors.push(
        `cross-lane manifest owner mismatch ${row.id}: W5 ${row.owner} != W1 ${w1Member.owningFeature}`
      );
    }
    if (command.featureOwner !== w1Member.owningFeature) {
      rowOwnerMismatch = true;
      errors.push(
        `cross-lane command owner mismatch ${row.id}: W5 ${command.featureOwner} != W1 ${w1Member.owningFeature}`
      );
    }
    if (rowOwnerMismatch) ownerMismatches += 1;
  }

  return {
    errors,
    counts: {
      comparedRequiredW1W5Members: comparedRows.length,
      missingW1Rows,
      ownerMismatches,
    },
  };
}

export async function extractInterfaceMembers(root, sourceScopes) {
  const extracted = [];
  for (const scope of sourceScopes) {
    const sourceText = await readFile(resolve(root, scope.sourceFile), 'utf8');
    const sourceFile = ts.createSourceFile(
      scope.sourceFile,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const interfaces = new Set(scope.interfaces);
    for (const statement of sourceFile.statements) {
      if (!ts.isInterfaceDeclaration(statement) || !interfaces.has(statement.name.text)) continue;
      for (const member of statement.members) {
        if (!member.name || !ts.isIdentifier(member.name)) {
          throw new Error(`Unsupported computed member in ${statement.name.text}`);
        }
        extracted.push({
          id: `${statement.name.text}.${member.name.text}`,
          interfaceName: statement.name.text,
          sourceMethod: member.name.text,
          sourceFile: scope.sourceFile,
        });
      }
      interfaces.delete(statement.name.text);
    }
    if (interfaces.size) {
      throw new Error(
        `Mutation surface interfaces absent from ${scope.sourceFile}: ${[...interfaces].join(', ')}`
      );
    }
  }
  return extracted;
}

export async function verifyMutationCensus({ root, manifest, catalog }) {
  const errors = [];
  const extracted = await extractInterfaceMembers(root, manifest.sourceScopes ?? []);
  const extractedById = new Map(extracted.map((row) => [row.id, row]));
  const manifestById = new Map();
  for (const row of manifest.rows ?? []) {
    if (manifestById.has(row.id)) errors.push(`duplicate disposition row ${row.id}`);
    manifestById.set(row.id, row);
    if (!DISPOSITIONS.has(row.disposition)) {
      errors.push(`invalid disposition ${row.id}=${row.disposition}`);
    }
  }

  for (const row of extracted) {
    const disposition = manifestById.get(row.id);
    if (!disposition) {
      errors.push(`source member missing disposition ${row.id}`);
      continue;
    }
    if (
      disposition.interfaceName !== row.interfaceName ||
      disposition.sourceMethod !== row.sourceMethod ||
      disposition.sourceFile !== row.sourceFile
    ) {
      errors.push(`source identity mismatch ${row.id}`);
    }
  }
  for (const row of manifest.rows ?? []) {
    if (!extractedById.has(row.id))
      errors.push(`stale disposition without source member ${row.id}`);
  }

  const requiredRows = (manifest.rows ?? []).filter(
    (row) => row.disposition === 'required_hosted_v1_mutation'
  );
  const mappedCatalogMethods = new Map();
  for (const command of catalog.commands ?? []) {
    for (const sourceMethod of command.sourceMethods ?? []) {
      const mappings = mappedCatalogMethods.get(sourceMethod) ?? [];
      mappings.push(command);
      mappedCatalogMethods.set(sourceMethod, mappings);
    }
  }
  const requiredCatalogMethods = new Set();
  for (const row of requiredRows) {
    const sourceMethod = sourceMethodForCatalog(row);
    requiredCatalogMethods.add(sourceMethod);
    const commands = mappedCatalogMethods.get(sourceMethod) ?? [];
    if (commands.length !== 1) {
      errors.push(`required mutation must map exactly once ${row.id}=${commands.length}`);
      continue;
    }
    const [command] = commands;
    if (command.commandKind !== row.commandKind) {
      errors.push(`command kind mismatch ${row.id}: ${command.commandKind} != ${row.commandKind}`);
    }
    if (command.featureOwner !== row.owner) {
      errors.push(`owner mismatch ${row.id}: ${command.featureOwner} != ${row.owner}`);
    }
  }
  for (const [sourceMethod] of mappedCatalogMethods) {
    if (!requiredCatalogMethods.has(sourceMethod)) {
      errors.push(`catalog method lacks required mutation disposition ${sourceMethod}`);
    }
  }

  return {
    errors,
    extracted,
    requiredRows,
    counts: {
      extracted: extracted.length,
      dispositions: manifest.rows?.length ?? 0,
      required: requiredRows.length,
      query: (manifest.rows ?? []).filter((row) => row.disposition === 'query').length,
      ephemeral: (manifest.rows ?? []).filter((row) => row.disposition === 'ephemeral').length,
      deferred: (manifest.rows ?? []).filter((row) => row.disposition === 'deferred').length,
    },
  };
}
