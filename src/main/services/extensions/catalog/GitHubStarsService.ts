/**
 * GitHubStarsService — fetches stargazer counts from the GitHub public API.
 *
 * - Batch interface: accepts repository URLs, returns map of URL → stars
 * - In-memory cache with 1-hour TTL
 * - Concurrency-limited to 5 parallel requests
 * - Silent failure: 404, timeout, rate-limit → entry skipped
 */

import https from 'node:https';

import { parseGitHubOwnerRepo } from '@shared/utils/extensionNormalizers';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('Extensions:GitHubStars');

// ── Constants ──────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60_000; // 1 hour
const HTTP_TIMEOUT_MS = 10_000; // 10 seconds
const MAX_CONCURRENCY = 5;
const MAX_BODY_SIZE = 256 * 1024; // 256KB (GitHub repo JSON is ~10KB)

// ── Cache entry ────────────────────────────────────────────────────────────

interface CacheEntry {
  stars: number;
  fetchedAt: number;
}

// ── Service ────────────────────────────────────────────────────────────────

export class GitHubStarsService {
  private cache = new Map<string, CacheEntry>();

  /**
   * Fetch GitHub stars for a batch of repository URLs.
   * Returns `Record<repositoryUrl, starCount>` — only includes URLs with valid results.
   */
  async fetchStars(repositoryUrls: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    const tasks: { url: string; owner: string; repo: string }[] = [];

    for (const url of repositoryUrls) {
      const parsed = parseGitHubOwnerRepo(url);
      if (!parsed) continue;

      const cacheKey = `${parsed.owner}/${parsed.repo}`.toLowerCase();
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        result[url] = cached.stars;
        continue;
      }

      tasks.push({ url, owner: parsed.owner, repo: parsed.repo });
    }

    if (tasks.length === 0) return result;

    // Fetch with concurrency limit
    const outcomes = await this.withConcurrencyLimit(
      tasks.map(({ url, owner, repo }) => async () => {
        const stars = await this.fetchSingle(owner, repo);
        if (stars != null) {
          const cacheKey = `${owner}/${repo}`.toLowerCase();
          this.cache.set(cacheKey, { stars, fetchedAt: Date.now() });
          result[url] = stars;
        }
      }),
      MAX_CONCURRENCY
    );

    // Log any failures for debugging (already silent to caller)
    const failures = outcomes.filter((o) => o === 'error').length;
    if (failures > 0) {
      logger.debug(
        `GitHub stars: ${tasks.length - failures}/${tasks.length} fetched, ${failures} failed`
      );
    }

    return result;
  }

  /**
   * Fetch stargazer count for a single repo. Returns null on any error.
   */
  private async fetchSingle(owner: string, repo: string): Promise<number | null> {
    try {
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const { statusCode, body } = await githubGet(url);

      if (statusCode !== 200) {
        if (statusCode === 403 || statusCode === 429) {
          logger.debug(`GitHub API rate limit hit (${statusCode}), skipping remaining`);
        }
        return null;
      }

      const data = JSON.parse(body) as { stargazers_count?: number };
      return typeof data.stargazers_count === 'number' ? data.stargazers_count : null;
    } catch {
      return null;
    }
  }

  /**
   * Run async tasks with a concurrency limit.
   */
  private async withConcurrencyLimit(
    tasks: (() => Promise<void>)[],
    limit: number
  ): Promise<('ok' | 'error')[]> {
    const results: ('ok' | 'error')[] = [];
    let index = 0;

    const run = async (): Promise<void> => {
      while (index < tasks.length) {
        const i = index++;
        try {
          await tasks[i]();
          results[i] = 'ok';
        } catch {
          results[i] = 'error';
        }
      }
    };

    const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => run());
    await Promise.all(workers);
    return results;
  }
}

// ── HTTP helper (GitHub-specific) ──────────────────────────────────────────

function githubGet(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const settleResolve = (v: { statusCode: number; body: string }): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const settleReject = (e: Error): void => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    };

    const req = https.get(
      url,
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'agent-teams-ui',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let totalSize = 0;

        res.on('data', (c: Buffer) => {
          totalSize += c.length;
          if (totalSize > MAX_BODY_SIZE) {
            res.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          settleResolve({ statusCode: status, body: Buffer.concat(chunks).toString('utf-8') })
        );
        res.on('error', settleReject);
      }
    );

    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error(`Timeout: ${url}`)));
    req.on('error', (e) => settleReject(e instanceof Error ? e : new Error(String(e))));
  });
}
