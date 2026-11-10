import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  FALLBACK_APP_LOCALE,
  RESOLVED_APP_LOCALES,
  TRANSLATION_NAMESPACES,
} from '../../src/features/localization/contracts';
import { validateTranslationCatalogs } from '../../src/features/localization/core/application/validateTranslationCatalogs';

import type {
  CatalogValidationIssue,
  TranslationCatalogByNamespace,
  TranslationCatalogsByLocale,
  TranslationCatalogNode,
} from '../../src/features/localization/core/application/validateTranslationCatalogs';

const repoRoot = process.cwd();
const localesRoot = path.join(repoRoot, 'src/features/localization/renderer/locales');

const issues: CatalogValidationIssue[] = [];
const catalogs = await readCatalogs(localesRoot, issues);

validateConfiguredLocales(catalogs, issues);
validateConfiguredNamespaces(catalogs, issues);
issues.push(...validateTranslationCatalogs(catalogs, FALLBACK_APP_LOCALE));

if (issues.length > 0) {
  for (const issue of issues) {
    console.error(`${issue.locale}/${issue.namespace}: ${issue.message}`);
  }
  process.exit(1);
}

console.log(
  `i18n catalogs valid (${RESOLVED_APP_LOCALES.length} locale set, ${TRANSLATION_NAMESPACES.length} namespaces)`
);

async function readCatalogs(
  root: string,
  issuesOutput: CatalogValidationIssue[]
): Promise<TranslationCatalogsByLocale> {
  const localeEntries = await readdir(root, { withFileTypes: true });
  const result: TranslationCatalogsByLocale = {};

  for (const localeEntry of localeEntries) {
    if (!localeEntry.isDirectory()) continue;

    const locale = localeEntry.name;
    const localeDir = path.join(root, locale);
    const namespaceEntries = await readdir(localeDir, { withFileTypes: true });
    const localeCatalog: TranslationCatalogByNamespace = {};

    for (const namespaceEntry of namespaceEntries) {
      if (!namespaceEntry.isFile() || !namespaceEntry.name.endsWith('.json')) continue;

      const namespace = namespaceEntry.name.slice(0, -'.json'.length);
      const filePath = path.join(localeDir, namespaceEntry.name);
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;

      if (!isTranslationCatalogNode(parsed)) {
        issuesOutput.push({
          type: 'shape-mismatch',
          locale,
          namespace,
          message: `Catalog "${locale}/${namespace}.json" must contain a JSON object of nested strings`,
        });
        continue;
      }

      localeCatalog[namespace] = parsed;
    }

    result[locale] = localeCatalog;
  }

  return result;
}

function validateConfiguredLocales(
  catalogs: TranslationCatalogsByLocale,
  issuesOutput: CatalogValidationIssue[]
): void {
  for (const locale of RESOLVED_APP_LOCALES) {
    if (!catalogs[locale]) {
      issuesOutput.push({
        type: 'missing-namespace',
        locale,
        namespace: '*',
        message: `Configured locale "${locale}" has no catalog directory`,
      });
    }
  }

  for (const locale of Object.keys(catalogs)) {
    if (!RESOLVED_APP_LOCALES.includes(locale as (typeof RESOLVED_APP_LOCALES)[number])) {
      issuesOutput.push({
        type: 'extra-key',
        locale,
        namespace: '*',
        message: `Catalog directory "${locale}" is not listed in RESOLVED_APP_LOCALES`,
      });
    }
  }
}

function validateConfiguredNamespaces(
  catalogs: TranslationCatalogsByLocale,
  issuesOutput: CatalogValidationIssue[]
): void {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const namespace of TRANSLATION_NAMESPACES) {
      if (!catalog[namespace]) {
        issuesOutput.push({
          type: 'missing-namespace',
          locale,
          namespace,
          message: `Configured namespace "${namespace}" is missing for locale "${locale}"`,
        });
      }
    }

    for (const namespace of Object.keys(catalog)) {
      if (!TRANSLATION_NAMESPACES.includes(namespace as (typeof TRANSLATION_NAMESPACES)[number])) {
        issuesOutput.push({
          type: 'extra-key',
          locale,
          namespace,
          message: `Catalog namespace "${namespace}" is not listed in TRANSLATION_NAMESPACES`,
        });
      }
    }
  }
}

function isTranslationCatalogNode(value: unknown): value is TranslationCatalogNode {
  if (typeof value === 'string') return true;
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isTranslationCatalogNode);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
