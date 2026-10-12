const fs = require('fs');
const path = require('path');

const ARTIFACT_PATH = path.join(__dirname, 'generated', 'chatVisualizationProtocol.json');

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readChatVisualizationProtocol() {
    let artifact;
    try {
        artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            throw new Error('Generated chat visualization protocol is missing; run the protocol generator after feature integration');
        }
        throw error;
    }

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
        '- After launch readiness is confirmed, before producing an openui-lang visualization, call member_briefing once and follow its complete chat visualization protocol.',
        '- Until that refresh succeeds, send ordinary prose or ordinary code instead of inventing visualization signatures or emitting an incomplete fence.',
    ].join('\n');
}

module.exports = {
    ARTIFACT_PATH,
    buildChatVisualizationProtocolText,
    buildChatVisualizationRefreshInstruction,
    formatChatVisualizationProtocolText,
    readChatVisualizationProtocol,
};
