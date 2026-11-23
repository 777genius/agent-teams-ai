import { EXTERNAL_AGENT_RENDERER_MARKER } from '../../contracts';

import { buildMcpRegistrationCommand } from './connectionPrompt';

import type { ConnectionInfoV1 } from '../../contracts';

/** CDP endpoints are usable only for the currently observed, authorized renderer target. */
export function hasReadyRendererAccess(connection: ConnectionInfoV1): boolean {
  const { cdp } = connection;
  return (
    cdp.status === 'ready' &&
    connection.capabilities.rendererControl &&
    Boolean(cdp.httpOrigin && cdp.browserWsUrl && cdp.rendererTargetId && cdp.rendererWsUrl)
  );
}

/** Bind setup to one app and require independent MCP and CDP evidence. */
export function buildConnectionSetupPrompt(connection: ConnectionInfoV1): string {
  if (
    connection.mcp.status !== 'ready' ||
    connection.control.status !== 'ready' ||
    !connection.mcp.url
  ) {
    throw new Error('MCP_NOT_READY');
  }
  if (!hasReadyRendererAccess(connection)) throw new Error('CDP_NOT_READY');
  return [
    'Connect to the currently running Agent Teams app on this computer using both its MCP server and renderer CDP. Do not start, stop, modify, or create teams as part of connection setup.',
    `Expected app context: ${JSON.stringify(connection.context)}`,
    `App MCP Streamable HTTP endpoint: ${connection.mcp.url}`,
    `Observed CDP HTTP origin: ${connection.cdp.httpOrigin}`,
    `Observed browser WebSocket: ${connection.cdp.browserWsUrl}`,
    `Observed renderer target ID: ${connection.cdp.rendererTargetId}`,
    `Observed renderer WebSocket: ${connection.cdp.rendererWsUrl}`,
    `Observed renderer target generation: ${connection.cdp.targetGeneration}`,
    'First try the existing native MCP tool app_get_connection_info. If the tool is unavailable, identify your actual MCP client and register this endpoint with the supported method for that client. Do not run commands for other clients or overwrite unrelated entries.',
    `For Codex: ${buildMcpRegistrationCommand(connection, 'codex')}`,
    `For Claude Code (POSIX shell or PowerShell): ${buildMcpRegistrationCommand(connection, 'claude')}`,
    'For another MCP client, use its supported Streamable HTTP server setup. Registration may require a new session or a reload before tools become available; if so, tell the user exactly what to do and continue only after the tools are available.',
    'A cloud-only agent cannot reach localhost without a local executor. If you cannot access this computer or register MCP tools, explain the limitation; do not claim to be connected.',
    'Call app_get_connection_info and compare appInstanceId and dataRootFingerprint with the expected app context above. If either differs, stop and ask for a fresh setup prompt. If only connectionGeneration changed, use the current context from discovery.',
    'For CDP, use your own local CDP client or tools. Use the current CDP endpoints and exact renderer target returned by live app_get_connection_info; never assume the copied endpoint, first target, or window title is still correct. If CDP is not ready, ask the user to enable UI access, restart the app, and copy a fresh setup prompt.',
    `Connect to the exact live renderer WebSocket, read window.${EXTERNAL_AGENT_RENDERER_MARKER} via Runtime.evaluate, and compare appInstanceId, dataRootFingerprint and connectionGeneration with live MCP discovery before any UI interaction. Re-discover after a renderer reload or target generation change. CDP gives full renderer and exposed preload API access; the browser endpoint can enumerate other targets.`,
    'If you cannot use a CDP client or verify the renderer marker, report that CDP is unavailable and do not claim both connections succeeded. Never bypass MCP mutation controls through CDP or preload APIs.',
    'Only after MCP discovery and CDP renderer verification both succeed, call app_show_connection_confirmation with your client name as agentName, cdpVerified=true, and the current discovery context as expectedContext. This asks the app to display a confirmation.',
    'Report MCP and CDP results separately. If the confirmation tool is unavailable or the request fails, explain the exact result; do not pretend the dialog was shown. The client name and CDP verification claim are self-reported. Keep the app open while using its tools.',
  ].join('\n');
}
