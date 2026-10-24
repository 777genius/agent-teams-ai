import type { AuthoritativeReviewFiles } from './authoritativeReviewFiles.js';
import type { FileChangeWithContent, SnippetDiff } from '../../contracts.js';
import { createHash, randomUUID } from 'crypto';
import type { ReviewWriterContext } from './ports.js';
import { MAX_DISPLAYED_REVIEW_SNAPSHOTS, REVIEW_SNAPSHOT_TTL_MS } from './limits.js';
import { normalizeReviewPathForIdentity } from './scopeAuthorization.js';

export interface DisplayedReviewSnapshot {
  teamName: string;
  filePath: string;
  reviewKey: string;
  snippetFingerprint: string;
  content: FileChangeWithContent;
  expiresAt: number;
}

export function fingerprintReviewSnippets(snippets: SnippetDiff[]): string {
  return createHash('sha256').update(JSON.stringify(snippets)).digest('hex');
}

export function registerDisplayedReviewSnapshot(
  env: Pick<ReviewWriterContext, 'assertActive' | 'snapshots'>,
  teamName: string,
  filePath: string,
  snippets: SnippetDiff[],
  content: FileChangeWithContent,
  reviewKey: string
): FileChangeWithContent {
  const now = Date.now();
  for (const [token, snapshot] of env.snapshots) {
    if (snapshot.expiresAt <= now) env.snapshots.delete(token);
  }
  while (env.snapshots.size >= MAX_DISPLAYED_REVIEW_SNAPSHOTS) {
    const oldestToken = env.snapshots.keys().next().value;
    if (!oldestToken) break;
    env.snapshots.delete(oldestToken);
  }
  const token = randomUUID();
  const snapshotContent = { ...content, reviewSnapshotToken: token };
  env.assertActive();
  env.snapshots.set(token, {
    teamName,
    filePath: normalizeReviewPathForIdentity(filePath),
    reviewKey,
    snippetFingerprint: fingerprintReviewSnippets(snippets),
    content: snapshotContent,
    expiresAt: now + REVIEW_SNAPSHOT_TTL_MS,
  });
  return snapshotContent;
}

export function resolveDisplayedReviewSnapshot(
  env: Pick<ReviewWriterContext, 'assertActive' | 'snapshots'>,
  token: string | undefined,
  teamName: string,
  filePath: string,
  authoritativeSnippets: SnippetDiff[],
  reviewKey: string
): FileChangeWithContent {
  if (!token) {
    throw new Error('Displayed review snapshot is unavailable; reload Changes before rejecting.');
  }
  const snapshot = env.snapshots.get(token);
  if (
    !snapshot ||
    snapshot.expiresAt <= Date.now() ||
    snapshot.teamName !== teamName ||
    snapshot.filePath !== normalizeReviewPathForIdentity(filePath) ||
    snapshot.reviewKey !== reviewKey ||
    snapshot.snippetFingerprint !== fingerprintReviewSnippets(authoritativeSnippets)
  ) {
    env.snapshots.delete(token);
    throw new Error('Displayed review snapshot is stale; reload Changes before rejecting.');
  }
  snapshot.expiresAt = Date.now() + REVIEW_SNAPSHOT_TTL_MS;
  return {
    ...snapshot.content,
    filePath,
    snippets: authoritativeSnippets,
  };
}

export interface AuthorizedReviewRoot {
  lexicalPath: string;
  realPath: string;
}

export interface ReviewPathAuthorization {
  roots: AuthorizedReviewRoot[];
  reviewedFiles: AuthoritativeReviewFiles | null;
  selectedReviewKeys?: ReadonlyMap<string, string>;
  resolutionMemberName: string;
}
