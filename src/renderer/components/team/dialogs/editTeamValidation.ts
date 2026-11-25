import { parseNumericSuffixName } from '@shared/utils/teamMemberName';

import { validateMemberNameInline } from '../members/MembersEditorSection';

export function getInvalidMemberNamesError(
  members: readonly { name: string; removedAt?: number | string | null }[],
  messages: {
    empty: string;
    invalid: string;
    reserved: (name: string) => string;
    numericSuffix: (name: string, base: string) => string;
  }
): string | null {
  for (const member of members) {
    if (member.removedAt) continue;
    const name = member.name.trim();
    if (!name) return messages.empty;
    if (validateMemberNameInline(name) !== null) return messages.invalid;
    const lower = name.toLowerCase();
    if (lower === 'user' || lower === 'team-lead') return messages.reserved(name);
    const suffixInfo = parseNumericSuffixName(name);
    if (suffixInfo && suffixInfo.suffix >= 2) return messages.numericSuffix(name, suffixInfo.base);
  }
  return null;
}
