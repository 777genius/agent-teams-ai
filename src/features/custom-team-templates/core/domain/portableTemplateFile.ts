import type { PortableCustomTeamTemplateV1 } from '@features/custom-team-templates/contracts';

const DEFAULT_FILE_BASENAME = 'custom-team-template';
const MAX_FILE_BASENAME_LENGTH = 80;

/**
 * Windows reserves a device name even when an extension follows it, so
 * `CON.json` and `NUL.backup` are still not creatable files. The rule applies to
 * the stem before the first extension separator, and Windows also reserves the
 * superscript digits `¹`, `²` and `³` for `COM`/`LPT`.
 */
const RESERVED_WINDOWS_DEVICE_STEM = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;

/**
 * Returns true when a basename would collide with a reserved Windows device
 * name, checking only the stem before the first `.` separator.
 */
function hasReservedDeviceStem(baseName: string): boolean {
  const stem = baseName.split('.', 1)[0] ?? '';
  return RESERVED_WINDOWS_DEVICE_STEM.test(stem.trimEnd());
}

/**
 * Derives a safe suggested filename from a user-controlled template name.
 *
 * The result is always a basename ending in `.json`: path separators, Windows
 * reserved characters and control characters are replaced with spaces, leading
 * and trailing dots/spaces/dashes are removed so `.`/`..` cannot survive, and
 * reserved device stems (`CON`, `NUL.backup`, `COM¹`, ...) are prefixed. Only the
 * derived filename is changed; the stored template name is never renamed. The
 * renderer never supplies this value and never receives the destination
 * directory.
 */
export function buildCustomTeamTemplateFileName(templateName: string): string {
  const cleaned = templateName
    .normalize('NFC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s-]+|[.\s-]+$/g, '');
  const base = cleaned.slice(0, MAX_FILE_BASENAME_LENGTH).replace(/[.\s-]+$/g, '');
  const usableBase = base.length > 0 ? base : DEFAULT_FILE_BASENAME;
  const safeBase = hasReservedDeviceStem(usableBase) ? `template-${usableBase}` : usableBase;
  return `${safeBase}.json`;
}

/**
 * Serializes exactly the portable contract, in a fixed key order, with a final
 * newline. Rebuilding the object here means no local persistence metadata and
 * no stray property can be written even if a caller passes a wider object.
 */
export function serializeCustomTeamTemplatePortableFile(
  portable: PortableCustomTeamTemplateV1
): string {
  const document = {
    format: portable.format,
    schemaVersion: portable.schemaVersion,
    name: portable.name,
    ...(portable.description === undefined ? {} : { description: portable.description }),
    teamPrompt: portable.teamPrompt,
    members: portable.members.map((member) => ({
      name: member.name,
      ...(member.role === undefined ? {} : { role: member.role }),
      ...(member.workflow === undefined ? {} : { workflow: member.workflow }),
    })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
