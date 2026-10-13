export function getCommandOutputSummary(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) return '';
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}
