const MAX_PER_MINUTE = 10;
const PAIR_COOLDOWN_MS = 3000;
const MAX_CHAIN_DEPTH = 5;
const WINDOW_MS = 60000;

const teamCounters = new Map();
const pairTimestamps = new Map();

function cleanup(now) {
  for (const [team, timestamps] of teamCounters) {
    const fresh = timestamps.filter((ts) => ts > now - WINDOW_MS);
    if (fresh.length === 0) {
      teamCounters.delete(team);
    } else {
      teamCounters.set(team, fresh);
    }
  }
  for (const [key, ts] of pairTimestamps) {
    if (now - ts > WINDOW_MS) {
      pairTimestamps.delete(key);
    }
  }
}

function check(fromTeam, toTeam, chainDepth) {
  if (chainDepth >= MAX_CHAIN_DEPTH) {
    throw new Error(`Cross-team chain depth limit exceeded (max ${MAX_CHAIN_DEPTH})`);
  }

  const now = Date.now();
  cleanup(now);

  const counts = teamCounters.get(fromTeam) || [];
  const recentCount = counts.filter((ts) => ts > now - WINDOW_MS).length;
  if (recentCount >= MAX_PER_MINUTE) {
    throw new Error(`Cross-team rate limit exceeded for ${fromTeam} (max ${MAX_PER_MINUTE}/min)`);
  }

  const pairKey = `${fromTeam}\u2192${toTeam}`;
  const lastPairTs = pairTimestamps.get(pairKey);
  if (lastPairTs !== undefined && now - lastPairTs < PAIR_COOLDOWN_MS) {
    throw new Error(`Cross-team pair cooldown active: ${fromTeam} \u2192 ${toTeam}`);
  }
}

function record(fromTeam, toTeam) {
  const now = Date.now();
  const counts = teamCounters.get(fromTeam) || [];
  counts.push(now);
  teamCounters.set(fromTeam, counts);
  pairTimestamps.set(`${fromTeam}\u2192${toTeam}`, now);
}

function reset() {
  teamCounters.clear();
  pairTimestamps.clear();
}

module.exports = { check, record, reset };
