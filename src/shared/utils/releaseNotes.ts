interface ReleaseNoteEntry {
  readonly version?: unknown;
  readonly note?: unknown;
}

function isDownloadsHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  const markdownHeading = /^#{1,6}\s*(.+?)\s*#*\s*$/.exec(trimmed);
  const htmlHeading = /^<h[1-6][^>]*>\s*(.+?)\s*<\/h[1-6]>\s*$/i.exec(trimmed);
  const headingText = markdownHeading?.[1] ?? htmlHeading?.[1];
  if (!headingText) {
    return false;
  }

  const words = headingText.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.length > 0 && words.every((word) => word === 'download' || word === 'downloads');
}

export function stripDownloadsSection(markdown: string): string {
  const lines = markdown.split(/\r?\n/u);
  const downloadsHeadingIndex = lines.findIndex(isDownloadsHeading);
  if (downloadsHeadingIndex === -1) {
    return markdown.trimEnd();
  }

  return lines.slice(0, downloadsHeadingIndex).join('\n').trimEnd();
}

function normalizeReleaseNoteEntry(entry: unknown): { version: string; note: string } | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const { version, note } = entry as ReleaseNoteEntry;
  if (typeof version !== 'string' || version.trim() === '') {
    return null;
  }

  return {
    version: version.trim().replace(/^v/i, ''),
    note: typeof note === 'string' ? note : '',
  };
}

export function getUpdaterReleaseNoteForVersion(
  releaseNotes: unknown,
  version: string
): string | undefined {
  if (typeof releaseNotes === 'string') {
    return releaseNotes;
  }

  if (!Array.isArray(releaseNotes)) {
    return undefined;
  }

  const normalizedVersion = version.trim().replace(/^v/i, '');
  return (
    releaseNotes
      .map(normalizeReleaseNoteEntry)
      .find((entry) => entry?.version === normalizedVersion)?.note || undefined
  );
}

export function formatUpdaterReleaseNotes(releaseNotes: unknown): string | undefined {
  if (typeof releaseNotes === 'string') {
    const stripped = stripDownloadsSection(releaseNotes);
    return stripped || undefined;
  }

  if (!Array.isArray(releaseNotes)) {
    return undefined;
  }

  const formattedNotes = releaseNotes
    .map(normalizeReleaseNoteEntry)
    .filter((entry): entry is { version: string; note: string } => entry !== null)
    .map(({ version, note }) => {
      const strippedNote = stripDownloadsSection(note);
      return [`## v${version}`, strippedNote || '_No release notes provided._'].join('\n\n');
    });

  return formattedNotes.length > 0 ? formattedNotes.join('\n\n') : undefined;
}
