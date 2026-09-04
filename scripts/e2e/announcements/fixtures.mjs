import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { generateAnnouncements } from '../../announcements/generate.mjs';

// Authored raster fixtures; no external network, image binaries, or extra dependencies.
function png(width, height, diagram = false) {
  const crc = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const type = Buffer.from(name),
      size = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const block =
        diagram && y > height * 0.25 && y < height * 0.75 && x % (width / 3) < width * 0.23;
      const line = diagram && Math.abs(y - height / 2) < 3;
      const color = diagram
        ? block
          ? [86, 122, 244]
          : line
            ? [135, 160, 210]
            : [22, 30, 50]
        : [35 + Math.floor((100 * x) / width), 55 + Math.floor((80 * y) / height), 170];
      const offset = y * (width * 3 + 1) + x * 3 + 1;
      color.forEach((channel, index) => {
        raw[offset + index] = channel;
      });
    }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function richMarkdown(edit = false) {
  return `# Desktop announcements ${edit ? 'UPDATED SAME ID' : 'rich fixture'} 🚀

![Blue violet banner](assets/banner.png)

## Typography and structure

**Bold**, *italic*, ***both***, ~~struck~~ and \`inline code\`. Русский текст, 日本語, café, emoji 👩🏽‍💻.

> A quote with **emphasis**.
> > A nested quote with a [safe web link](https://example.com/).

1. First ordered item
   - Nested unordered item
     - Deep item
2. Second ordered item

- [x] Completed task
- [ ] Pending task

### Rich table

| Feature | Details | Link |
| :--- | :---: | ---: |
| **Bold cell** | \`code\` and *italic* | [Website](https://example.com/) |
| ~~Old~~ → new | 🚀 Ready | [Fragment](#typography-and-structure) |

![Pipeline diagram: three blue stages connected in sequence](assets/diagram.png)

#### TypeScript

\`\`\`typescript
interface Announcement { id: string; title: string }
const latest = (items: Announcement[]) => items.at(-1);
console.log(latest([{ id: 'fixture', title: 'Hello' }]));
\`\`\`

#### Python

\`\`\`python
def announce(name: str) -> str:
    return f"Hello, {name}!"
\`\`\`

##### JSON and shell

\`\`\`json
{"autoShowEnabled": true, "items": []}
\`\`\`

\`\`\`bash
printf '%s\\n' 'Documentation only - do not execute'
\`\`\`

###### Overflow and long fenced code

\`\`\`text
${Array.from({ length: 35 }, (_, i) => `${String(i + 1).padStart(2, '0')} ${'very_long_code_segment_'.repeat(12)}`).join('\n')}
\`\`\`

${'UnbreakableLongWord'.repeat(45)}

![Tiny GIF](assets/pixel.gif)

---

## Untrusted content probes

<script>window.__announcementUnsafeExecuted = true</script>
<iframe src="file:///etc/passwd"></iframe>
<button onclick="window.__announcementUnsafeExecuted = true">unsafe raw button</button>

[Unsafe javascript](javascript:alert(1))
[Unsafe file](file:///etc/passwd)
[Unsafe command](command:workbench.action.terminal.new)
[Unsafe task](task:fixture-task)
[Unsafe team](team:fixture-team)
[Unsafe protocol](vscode://file/etc/passwd)
[Unsafe data](data:text/html,payload)

End of rich fixture.
`;
}

export async function publishFixture(root, scenario = 'ten') {
  let prior = {};
  try {
    prior = JSON.parse(await readFile(path.join(root, 'published-meta.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sourceDir = path.join(root, 'source');
  await rm(sourceDir, { recursive: true, force: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    path.join(sourceDir, 'feed.config.json'),
    JSON.stringify({ autoShowEnabled: true })
  );
  const count =
    scenario === 'empty'
      ? 0
      : scenario === 'new'
        ? 11
        : scenario === 'edited'
          ? Object.keys(prior).length
          : 10;
  const now = Date.now();
  for (let index = 1; index <= count; index++) {
    const id = `fixture-${String(index).padStart(2, '0')}`;
    const dir = path.join(sourceDir, id);
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    const age = scenario === 'expired' ? 20 * 86400000 : (count - index + 1) * 60000;
    await writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        id,
        title: `Fixture ${String(index).padStart(2, '0')} - rich announcement`,
        status: 'published',
        publishedAt: new Date(now - age).toISOString(),
        showToNewUsers: scenario !== 'cohort',
        minUsageMinutes: 30,
      })
    );
    // Stable timestamps ensure editing the same ID does not accidentally create new order keys.
    if (scenario === 'edited' || scenario === 'new') {
      if (prior[id]) await writeFile(path.join(dir, 'meta.json'), JSON.stringify(prior[id]));
    }
    await writeFile(path.join(dir, 'body.md'), richMarkdown(scenario === 'edited'));
    await writeFile(path.join(dir, 'assets/banner.png'), png(1100, 240));
    await writeFile(path.join(dir, 'assets/diagram.png'), png(900, 240, true));
    await writeFile(
      path.join(dir, 'assets/pixel.gif'),
      Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    );
  }
  const feed = await generateAnnouncements({
    sourceDir,
    outputDir: path.join(root, 'public/announcements'),
  });
  await writeFile(
    path.join(root, 'published-meta.json'),
    JSON.stringify(
      Object.fromEntries(
        feed.items.map((item) => {
          const meta = { ...item };
          delete meta.bodyPath;
          delete meta.bodySha256;
          return [meta.id, meta];
        })
      )
    )
  );
  return feed;
}
