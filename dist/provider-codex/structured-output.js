export function parseCodexStructuredOutput(outputText, errorCode) {
    const direct = parseJson(outputText);
    if (direct.ok)
        return direct.value;
    const candidate = parseLastJsonCandidate(outputText);
    if (candidate)
        return candidate.value;
    throw new Error(errorCode);
}
function parseJson(value) {
    try {
        return { ok: true, value: JSON.parse(value) };
    }
    catch {
        return { ok: false };
    }
}
function parseLastJsonCandidate(value) {
    const candidates = [...jsonCandidates(value)];
    let lastCandidate = null;
    for (const candidate of outerJsonCandidates(candidates)) {
        if (!lastCandidate || candidate.index > lastCandidate.index) {
            lastCandidate = candidate;
        }
    }
    return lastCandidate;
}
function outerJsonCandidates(candidates) {
    const outer = new Set();
    let maxEnd = -1;
    for (const candidate of [...candidates].sort((left, right) => left.index - right.index || right.end - left.end)) {
        if (maxEnd >= candidate.end)
            continue;
        outer.add(candidate);
        maxEnd = candidate.end;
    }
    return candidates.filter((candidate) => outer.has(candidate));
}
function* jsonCandidates(value) {
    yield* fencedJsonCandidates(value);
    yield* balancedJsonCandidates(value, nonJsonFenceRanges(value));
}
function* fencedJsonCandidates(value) {
    for (const match of value.matchAll(/```\s*(?:json)?\s*([\s\S]*?)```/gi)) {
        const content = match[1];
        if (!content)
            continue;
        const parsed = parseJson(content.trim());
        if (parsed.ok) {
            yield {
                index: match.index ?? 0,
                end: (match.index ?? 0) + match[0].length,
                value: parsed.value,
            };
        }
    }
}
function* balancedJsonCandidates(value, excludedRanges = []) {
    const stack = [];
    let inString = false;
    let escape = false;
    let excludedRangeIndex = 0;
    for (let index = 0; index < value.length; index++) {
        while (excludedRangeIndex < excludedRanges.length &&
            index >= excludedRanges[excludedRangeIndex].end) {
            excludedRangeIndex += 1;
        }
        const excludedRange = excludedRanges[excludedRangeIndex];
        if (excludedRange && index >= excludedRange.start) {
            stack.length = 0;
            inString = false;
            escape = false;
            index = excludedRange.end - 1;
            continue;
        }
        const char = value[index];
        if (stack.length > 0) {
            if (inString && (char === "\n" || char === "\r")) {
                stack.length = 0;
                inString = false;
                escape = false;
                continue;
            }
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
            if (inString)
                continue;
        }
        else {
            inString = false;
            escape = false;
        }
        if (char === "{" || char === "[") {
            stack.push({
                index,
                closing: char === "{" ? "}" : "]",
            });
            continue;
        }
        if (char !== "}" && char !== "]")
            continue;
        const bracket = stack.at(-1);
        if (!bracket || bracket.closing !== char) {
            stack.length = 0;
            inString = false;
            escape = false;
            continue;
        }
        stack.pop();
        const parsed = parseJson(value.slice(bracket.index, index + 1));
        if (parsed.ok) {
            yield {
                index: bracket.index,
                end: index + 1,
                value: parsed.value,
            };
        }
    }
}
function nonJsonFenceRanges(value) {
    const ranges = [];
    let searchFrom = 0;
    while (searchFrom < value.length) {
        const fence = nextFence(value, searchFrom);
        if (!fence)
            break;
        const headerStart = fence.start + fence.marker.length;
        const lineEnd = firstLineEnd(value, headerStart);
        const header = value.slice(headerStart, lineEnd.index);
        const language = header.trim().split(/\s+/)[0]?.toLowerCase();
        const nextSearchFrom = lineEnd.end;
        if (!language || language === "json") {
            searchFrom = nextSearchFrom;
            continue;
        }
        const fenceEnd = value.indexOf(fence.marker, nextSearchFrom);
        const end = fenceEnd < 0 ? value.length : fenceEnd + fence.marker.length;
        ranges.push({ start: fence.start, end });
        searchFrom = end;
    }
    return ranges;
}
function nextFence(value, searchFrom) {
    const backtick = value.indexOf("```", searchFrom);
    const tilde = value.indexOf("~~~", searchFrom);
    if (backtick < 0 && tilde < 0)
        return null;
    if (tilde < 0 || (backtick >= 0 && backtick <= tilde)) {
        return { start: backtick, marker: "```" };
    }
    return { start: tilde, marker: "~~~" };
}
function firstLineEnd(value, start) {
    const lineFeed = value.indexOf("\n", start);
    if (lineFeed < 0)
        return { index: value.length, end: value.length };
    const carriageReturnIndex = lineFeed > start && value[lineFeed - 1] === "\r" ? lineFeed - 1 : lineFeed;
    return { index: carriageReturnIndex, end: lineFeed + 1 };
}
//# sourceMappingURL=structured-output.js.map