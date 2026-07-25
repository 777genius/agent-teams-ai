const appServerTurnErrorPrefix = "codex_app_server_turn_error:";
const appServerReconnectTimeoutPrefix =
  "codex_app_server_reconnect_timeout:";
const appServerProviderErrorPrefix = "codex_app_server_error:";

export function isCodexAppServerReconnectTimeoutCause(
  value: unknown,
): boolean {
  const cause = unwrapCodexAppServerTurnError(value);
  return cause?.startsWith(appServerReconnectTimeoutPrefix) === true;
}

export function isCodexAppServerRecoverableProviderFailureCause(
  value: unknown,
): boolean {
  const cause = unwrapCodexAppServerTurnError(value);
  return (
    cause?.startsWith(appServerReconnectTimeoutPrefix) === true ||
    cause?.startsWith(appServerProviderErrorPrefix) === true
  );
}

function unwrapCodexAppServerTurnError(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.startsWith(appServerTurnErrorPrefix)
    ? value.slice(appServerTurnErrorPrefix.length)
    : value;
}
