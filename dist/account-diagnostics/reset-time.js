export function parseLimitResetFromText(input) {
    const rawResetText = extractResetText(input.text);
    if (!rawResetText)
        return {};
    const relative = parseRelativeReset(rawResetText, input.now);
    if (relative)
        return { rawResetText, limitResetAt: relative };
    const absolute = parseAbsoluteReset(rawResetText, input.now);
    if (absolute)
        return { rawResetText, limitResetAt: absolute };
    return { rawResetText };
}
function extractResetText(text) {
    const normalized = text.replace(/\s+/g, " ");
    const relative = normalized.match(/\b(?:try again|reset(?:s)?|available|limit resets?)(?:[^.:\n]{0,80})\bin\s+((?:(?:\d+)\s*(?:d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\s*){1,4})/i);
    if (relative?.[1])
        return relative[1].trim();
    const explicitDate = normalized.match(/\b(?:try again|reset(?:s)?|available|limit resets?)(?:[^.\n]{0,80})\bat\s+([A-Z][a-z]{2,8}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4},?\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
    if (explicitDate?.[1])
        return explicitDate[1].trim();
    const clockTime = normalized.match(/\b(?:try again|reset(?:s)?|available|limit resets?)(?:[^.\n]{0,80})\bat\s+(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    if (clockTime?.[1])
        return clockTime[1].trim();
    const looseClockTime = normalized.match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/i);
    return looseClockTime?.[1]?.trim() ?? null;
}
function parseRelativeReset(raw, now) {
    const matches = [...raw.matchAll(/(\d+)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/gi)];
    if (matches.length === 0)
        return null;
    let ms = 0;
    for (const match of matches) {
        const amount = Number(match[1]);
        const unit = match[2]?.toLowerCase();
        if (!Number.isFinite(amount) || !unit)
            return null;
        if (unit.startsWith("d"))
            ms += amount * 24 * 60 * 60 * 1000;
        else if (unit.startsWith("h"))
            ms += amount * 60 * 60 * 1000;
        else
            ms += amount * 60 * 1000;
    }
    return new Date(now.getTime() + ms);
}
function parseAbsoluteReset(raw, now) {
    const cleaned = raw.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
    const clock = cleaned.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (clock) {
        const hours = Number(clock[1]);
        const minutes = Number(clock[2]);
        const meridiem = clock[3]?.toUpperCase();
        if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59 || !meridiem) {
            return null;
        }
        const normalizedHours = meridiem === "AM" ? hours % 12 : hours === 12 ? 12 : hours + 12;
        const reset = new Date(now);
        reset.setHours(normalizedHours, minutes, 0, 0);
        if (reset.getTime() <= now.getTime()) {
            reset.setDate(reset.getDate() + 1);
        }
        return reset;
    }
    const parsed = new Date(cleaned);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
}
//# sourceMappingURL=reset-time.js.map