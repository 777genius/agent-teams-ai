import type { SkillCatalogItem } from '@shared/types/extensions';

const ROOT_PRECEDENCE: Record<SkillCatalogItem['rootKind'], number> = {
  claude: 0,
  cursor: 1,
  agents: 2,
};

export class SkillValidator {
  annotateCatalog(items: SkillCatalogItem[]): SkillCatalogItem[] {
    const withDuplicates = this.annotateDuplicateNames(items);
    return withDuplicates.sort((a, b) => {
      if (a.isValid !== b.isValid) return a.isValid ? -1 : 1;
      if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1;
      if (a.rootKind !== b.rootKind)
        return ROOT_PRECEDENCE[a.rootKind] - ROOT_PRECEDENCE[b.rootKind];
      return a.name.localeCompare(b.name);
    });
  }

  private annotateDuplicateNames(items: SkillCatalogItem[]): SkillCatalogItem[] {
    const itemsByName = new Map<string, SkillCatalogItem[]>();
    for (const item of items) {
      const key = item.name.trim().toLowerCase();
      const bucket = itemsByName.get(key) ?? [];
      bucket.push(item);
      itemsByName.set(key, bucket);
    }

    return items.map((item) => {
      const key = item.name.trim().toLowerCase();
      const duplicates = itemsByName.get(key) ?? [];
      if (duplicates.length <= 1) {
        return item;
      }

      if (item.issues.some((issue) => issue.code === 'duplicate-name')) {
        return item;
      }

      const otherLocations = duplicates
        .filter((candidate) => candidate.id !== item.id)
        .map((candidate) => `${candidate.skillDir} (${this.formatRootLabel(candidate)})`)
        .filter((value, index, values) => values.indexOf(value) === index)
        .join('; ');

      return {
        ...item,
        issues: [
          ...item.issues,
          {
            code: 'duplicate-name',
            message: `Another copy of "${item.name}" exists at: ${otherLocations}. Both entries are shown separately.`,
            severity: 'warning',
          },
        ],
      };
    });
  }

  private formatRootLabel(item: SkillCatalogItem): string {
    return item.scope === 'project' ? `project .${item.rootKind}` : `.${item.rootKind}`;
  }
}
