interface ReleaseNoteEntry {
  readonly version?: unknown;
  readonly note?: unknown;
}

function readHeading(line: string): { level: number; downloads: boolean } | null {
  const trimmed = line.trim();
  const markdownHeading = /^(#{1,6})\s*(.+?)\s*#*\s*$/.exec(trimmed);
  const htmlHeading = /^<h([1-6])[^>]*>\s*(.+?)\s*<\/h\1>\s*$/i.exec(trimmed);
  const headingText = markdownHeading?.[2] ?? htmlHeading?.[2];
  if (!headingText) {
    return null;
  }

  const words = headingText.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return {
    level: markdownHeading ? markdownHeading[1]!.length : Number(htmlHeading![1]),
    downloads:
      words.length > 0 && words.every((word) => word === 'download' || word === 'downloads'),
  };
}

export function stripDownloadsSection(markdown: string): string {
  const lines = markdown.split(/\r?\n/u);
  const retained: string[] = [];
  let downloadsLevel: number | null = null;
  let fence: { marker: string; length: number } | null = null;

  for (const line of lines) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1]![0] === fence.marker &&
        fenceMatch[1]!.length >= fence.length &&
        fenceMatch[2]!.trim() === ''
      ) {
        fence = null;
      }
      if (downloadsLevel === null) retained.push(line);
      continue;
    }
    if (fenceMatch && (fenceMatch[1]![0] === '~' || !fenceMatch[2]!.includes('`'))) {
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      if (downloadsLevel === null) retained.push(line);
      continue;
    }

    const heading = readHeading(line);
    if (downloadsLevel !== null && heading && heading.level <= downloadsLevel) {
      downloadsLevel = null;
    }
    if (downloadsLevel === null && heading?.downloads) {
      downloadsLevel = heading.level;
    }
    if (downloadsLevel === null) retained.push(line);
  }

  return retained.length === lines.length ? markdown.trimEnd() : retained.join('\n').trimEnd();
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
