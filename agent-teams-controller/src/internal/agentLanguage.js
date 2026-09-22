function getSystemLocale() {
    const lang = typeof process.env.LANG === 'string' ? process.env.LANG.trim() : '';
    if (!lang) return 'en';
    return lang.split('.')[0].replace('_', '-');
}

function extractPrimaryLanguage(locale) {
    const normalized = String(locale || '').trim();
    const dash = normalized.indexOf('-');
    return dash > 0 ? normalized.slice(0, dash) : normalized || 'en';
}

function resolveLanguageName(code, systemLocale) {
    const effectiveCode = code === 'system' ? extractPrimaryLanguage(systemLocale || 'en') : code;
    try {
        const displayNames = new Intl.DisplayNames([effectiveCode], { type: 'language' });
        const name = displayNames.of(effectiveCode);
        if (name) {
            return name.charAt(0).toUpperCase() + name.slice(1);
        }
    } catch {
        // Ignore Intl lookup failures and fall back to the raw code.
    }
    return effectiveCode;
}

function buildMemberLanguageInstruction(config) {
    const configured =
        config && typeof config.language === 'string' && config.language.trim() ?
        config.language.trim() :
        '';
    if (!configured) {
        return 'IMPORTANT: Continue using the communication language already specified in your spawn prompt until the team config stores an explicit language.';
    }
    const language = resolveLanguageName(configured, getSystemLocale());
    return `IMPORTANT: Communicate in ${language}. All messages, summaries, and task descriptions MUST be in ${language}.`;
}

module.exports = {
    buildMemberLanguageInstruction,
};
