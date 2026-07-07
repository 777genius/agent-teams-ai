export type ParseJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

export function parseStructuredJson(value: string): unknown {
  const direct = parseJson(value);
  if (direct.ok) return direct.value;
  const fence = value.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    const parsed = parseJson(fence[1].trim());
    if (parsed.ok) return parsed.value;
  }
  const balanced = extractBalancedJson(value);
  if (balanced.ok) return balanced.value;
  throw new Error("claude_structured_output_invalid");
}

function parseJson(value: string): ParseJsonResult {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function extractBalancedJson(value: string): ParseJsonResult {
  const start = value.indexOf("{");
  if (start === -1) return { ok: false };
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let index = start; index < value.length; index++) {
    const char = value[index]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\" && inString) {
      escape = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) {
        const parsed = parseJson(value.slice(start, index + 1));
        if (parsed.ok) return parsed;
        return extractBalancedJson(value.slice(index + 1));
      }
    }
  }
  return { ok: false };
}
