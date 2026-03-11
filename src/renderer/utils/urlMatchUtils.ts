export interface TextMatch {
  start: number;
  end: number;
  value: string;
}

const URL_REGEX = /https?:\/\/[^\s]+/g;

function trimUrlMatch(rawUrl: string): string {
  return rawUrl.replace(/[),.!?;:]+$/g, '');
}

export function findUrlMatches(text: string): TextMatch[] {
  if (!text) return [];

  const matches: TextMatch[] = [];
  for (const match of text.matchAll(URL_REGEX)) {
    const rawValue = match[0];
    const start = match.index ?? -1;
    if (start < 0) continue;

    const trimmedValue = trimUrlMatch(rawValue);
    if (!trimmedValue) continue;

    matches.push({
      start,
      end: start + trimmedValue.length,
      value: trimmedValue,
    });
  }

  return matches;
}

export function findUrlBoundary(text: string, cursorPos: number): TextMatch | null {
  return (
    findUrlMatches(text).find((match) => cursorPos >= match.start && cursorPos <= match.end) ?? null
  );
}

export function removeUrlMatchFromText(text: string, match: TextMatch): string {
  const removeEnd = match.end < text.length && text[match.end] === '\n' ? match.end + 1 : match.end;
  return text.slice(0, match.start) + text.slice(removeEnd);
}
