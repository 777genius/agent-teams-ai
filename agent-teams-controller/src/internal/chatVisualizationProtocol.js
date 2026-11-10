const artifact = require('./generated/chatVisualizationProtocol.json');

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readChatVisualizationProtocol() {
    if (
        !isRecord(artifact) ||
        artifact.protocolVersion !== 1 ||
        typeof artifact.instructions !== 'string' ||
        !artifact.instructions.trim() ||
        !isRecord(artifact.spec) ||
        typeof artifact.spec.root !== 'string' ||
        !isRecord(artifact.spec.schema) ||
        !isRecord(artifact.spec.components)
    ) {
        throw new Error('Generated chat visualization protocol has an invalid shape');
    }
    return artifact;
}

function formatChatVisualizationProtocolText(protocol) {
    return [
        `CHAT VISUALIZATION PROTOCOL v${protocol.protocolVersion}`,
        protocol.instructions.trim(),
        '',
        'AVAILABLE DISPLAY LIBRARY SPEC:',
        JSON.stringify(protocol.spec),
    ].join('\n');
}

function buildChatVisualizationProtocolText() {
    return formatChatVisualizationProtocolText(readChatVisualizationProtocol());
}

function buildChatVisualizationRefreshInstruction() {
    return [
        'CHAT VISUALIZATION REFRESH REQUIRED:',
        '- This chat supports built-in OpenUI without a separate tool or connector. Follow this conversation\'s existing reply delivery and visibility rules.',
        '- After launch readiness is confirmed, before fulfilling a request for OpenUI here or producing an openui-lang visualization: if the complete display library specification is missing from your context, call lead_briefing once if you are the team lead; otherwise call member_briefing once. Follow its complete chat visualization protocol. Reuse the specification when it is already present.',
        '- This refresh supplies display instructions for the current reply; it does not request launch readiness, unrelated board work, or a different reply destination.',
        '- If the required refresh fails, send ordinary prose explaining the limitation instead of inventing visualization signatures or emitting an incomplete fence. Do not refresh merely to acknowledge this reminder.',
    ].join('\n');
}

module.exports = {
    buildChatVisualizationProtocolText,
    buildChatVisualizationRefreshInstruction,
    formatChatVisualizationProtocolText,
    readChatVisualizationProtocol,
};
