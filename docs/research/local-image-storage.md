# Local Image Storage in Electron — Research & Recommendations

## Context

This document evaluates approaches for storing images/attachments locally in our Electron app (draft attachments in task descriptions, team-related images). The app uses Electron 28.x, React 18, and the main process already manages file I/O via IPC.

---

## Approach 1: Filesystem + SQLite Metadata (Recommended)

**How it works:** Store image files on disk under `app.getPath('userData')/attachments/`, serve them to the renderer via a custom `protocol.handle` scheme (`app://attachments/...`), and track metadata (path, original name, size, hash, created date, linked entity) in a `better-sqlite3` table.

### Pros
- Best I/O performance — direct filesystem reads, no serialization overhead.
- `protocol.handle` (Electron 28+) is the modern, secure way to serve local files without disabling `webSecurity`.
- `better-sqlite3` is synchronous, zero-dependency after rebuild, and already proven in the Electron ecosystem.
- Thumbnails generated once by `sharp` and stored alongside originals — no re-computation.
- Simple garbage collection: query metadata for orphaned entries, `fs.unlink` the files.
- No practical per-file size limit (limited only by disk space).

### Cons
- Requires `electron-rebuild` for `better-sqlite3` native bindings.
- Two storage systems to maintain (fs + sqlite).
- Path traversal must be prevented in the custom protocol handler (standard pattern, well-documented).

### Key implementation details

**Custom protocol (secure file serving):**
```ts
protocol.registerSchemesAsPrivileged([{
  scheme: 'app-img',
  privileges: { standard: true, secure: true, supportFetchAPI: true }
}]);

app.whenReady().then(() => {
  protocol.handle('app-img', (req) => {
    const { pathname } = new URL(req.url);
    const base = path.join(app.getPath('userData'), 'attachments');
    const resolved = path.resolve(base, pathname.slice(1));
    const rel = path.relative(base, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });
});
```

**Thumbnail generation (sharp):**
```ts
import sharp from 'sharp';

async function createThumbnail(inputPath: string, outputPath: string) {
  await sharp(inputPath)
    .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(outputPath);
}
```

**Metadata schema (better-sqlite3):**
```sql
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,        -- uuid
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  hash TEXT NOT NULL,          -- sha256 for dedup
  thumb_path TEXT,
  entity_type TEXT,            -- 'task' | 'team' | 'draft'
  entity_id TEXT,
  created_at INTEGER NOT NULL,
  accessed_at INTEGER
);
```

**Garbage collection:** Periodic sweep (on app start or every N hours) — find rows where `entity_id` no longer exists in the app state, delete file + row. Also enforce a configurable max total size (e.g. 500 MB) with LRU eviction based on `accessed_at`.

---

## Approach 2: Filesystem Only (Simplest)

**How it works:** Store images and a sidecar `.json` metadata file per attachment under `userData/attachments/{uuid}/`. No database.

### Pros
- Zero native dependencies — no `better-sqlite3` rebuild.
- Trivially portable (copy the folder).
- Simple to implement and debug.

### Cons
- Querying metadata (e.g. "all images for task X") requires scanning directory + reading JSON files — O(n).
- No transactional integrity between metadata and files.
- Deduplication harder without indexed hashes.
- Garbage collection requires full directory walk.

### When to choose this
If the total number of attachments is expected to stay under ~200 and complex queries are not needed. Good enough for an MVP.

---

## Approach 3: IndexedDB (Renderer-Side)

**How it works:** Store images as Blobs in IndexedDB (via Dexie.js wrapper) directly in the renderer process.

### Pros
- No native dependencies at all.
- Built-in browser API, well-documented.
- Transactional, supports indexes and queries.

### Cons
- **Performance:** Every read/write goes through Chromium's abstraction layers — significantly slower than direct fs I/O for large files.
- **Renderer-only:** Cannot be accessed from the main process without IPC round-trips.
- **Quota:** Chromium imposes storage quotas (varies, but often ~60% of disk on desktop).
- **Backup risk:** Data lives inside Chromium's internal LevelDB files — not human-readable, not easily portable.
- **Multi-window:** Concurrent access from multiple BrowserWindows can cause issues.

### When to choose this
Only if the app is being designed as a pure web app with Electron as a thin shell, and images are small (< 5 MB each).

---

## Comparison Matrix

| Criterion                 | FS + SQLite     | FS Only        | IndexedDB      |
|---------------------------|-----------------|----------------|----------------|
| Read/write performance    | Excellent       | Excellent      | Moderate       |
| Query capability          | Full SQL        | Manual scan    | IndexedDB API  |
| Native deps required      | better-sqlite3  | None           | None           |
| Max file size             | Disk limit      | Disk limit     | ~2 GB (blob)   |
| Garbage collection        | SQL query + unlink | Dir walk     | Cursor iterate |
| Security (serving to renderer) | protocol.handle | protocol.handle | N/A (in-process) |
| Deduplication             | Hash index      | Manual         | Hash index     |
| Complexity                | Medium          | Low            | Medium         |
| Multi-window safe         | Yes (main proc) | Yes (main proc)| Risky          |

---

## Recommendation

**Use Approach 1 (Filesystem + SQLite Metadata)** for this project.

Rationale:
1. The app already runs significant logic in the main process (file watchers, JSONL parsing, IPC handlers) — adding `better-sqlite3` fits the existing architecture.
2. `protocol.handle` is the Electron 28+ standard for secure local file serving; we should adopt it.
3. `sharp` handles thumbnailing efficiently (sub-millisecond per image) and outputs WebP for smaller sizes.
4. SQL metadata enables fast lookups by entity, dedup by hash, and clean GC queries.
5. The FS-only approach (Approach 2) is a valid MVP fallback if we want to avoid native deps initially, with a clear migration path to Approach 1 later.

### Size Limits & Quotas (Suggested Defaults)
- Max single file: 20 MB (covers high-res screenshots).
- Max total storage: 500 MB (configurable in settings).
- Thumbnail size: 300px max dimension, WebP quality 80.
- GC trigger: on app start + every 6 hours while running.
- Orphan grace period: 24 hours (allows undo of deletions).

### Libraries to Use
| Library | Version (as of 2026) | Purpose |
|---------|---------------------|---------|
| `better-sqlite3` | 11.x | Metadata storage |
| `sharp` | 0.33.x | Thumbnail generation, format conversion |
| `uuid` | 10.x (or `crypto.randomUUID()`) | Attachment IDs |

### Migration Path
Start with Approach 2 (FS-only) if speed matters. Add `better-sqlite3` when we need querying or the attachment count grows. The file layout (`userData/attachments/{uuid}.{ext}`) stays the same — only the metadata layer changes.
