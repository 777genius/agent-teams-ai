export function safeProcessFailureOutput(output: string): string {
  const compact = output.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(-1000) : "empty_process_output";
}
