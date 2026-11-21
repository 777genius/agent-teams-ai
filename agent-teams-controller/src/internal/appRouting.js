const {
  isRetryableControlError,
  requestJsonWithFallback,
  resolveControlBaseUrls,
} = require('./controlApiClient.js');

/**
 * Which physical team a name stands for (cross-team delivery, the board of a
 * project) is decided by the app, one rule for every caller. `null` means the
 * app cannot be reached (no published address, network error or timeout), so
 * the caller applies its offline behaviour. Any answer of the app is used or
 * thrown: a refusal, a server error, and also a 404 (an app without the route
 * must not silently get the old behaviour).
 */
async function requestAppRouting(context, pathname) {
  let baseUrls;
  try {
    baseUrls = resolveControlBaseUrls(context);
  } catch (error) {
    if (error && error.code === 'APP_CONTEXT_MISMATCH') throw error;
    return null;
  }
  try {
    return await requestJsonWithFallback(baseUrls, pathname);
  } catch (error) {
    const unreachable =
      isRetryableControlError(error) &&
      (error.retryableKind === 'network' || error.retryableKind === 'timeout');
    if (unreachable) return null;
    throw error;
  }
}

/** The physical team that receives a message from this team to `toTeam`. */
function getCrossTeamRecipient(context, toTeam) {
  return requestAppRouting(
    context,
    `/api/teams/${encodeURIComponent(context.teamName)}/cross-team/recipient?toTeam=${encodeURIComponent(toTeam)}`
  );
}

/** The teams this team can message, as the app lists them (project copies folded). */
function getCrossTeamTargets(context) {
  return requestAppRouting(
    context,
    `/api/teams/${encodeURIComponent(context.teamName)}/cross-team/targets`
  );
}

/** The physical team that holds the board of this team in `projectPath` (MCP board tools). */
function getBoardTarget(context, projectPath) {
  const query = projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : '';
  return requestAppRouting(
    context,
    `/api/teams/${encodeURIComponent(context.teamName)}/board-target${query}`
  );
}

module.exports = {
  getCrossTeamRecipient,
  getCrossTeamTargets,
  getBoardTarget,
};
