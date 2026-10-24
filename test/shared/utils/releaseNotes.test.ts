import { describe, expect, it } from 'vitest';

import {
  formatUpdaterReleaseNotes,
  getUpdaterReleaseNoteForVersion,
  stripDownloadsSection,
} from '../../../src/shared/utils/releaseNotes';

describe('releaseNotes utilities', () => {
  it('strips markdown Downloads sections even when they start the note', () => {
    expect(
      stripDownloadsSection(`### Downloads

<table>
<tr><td>installer links</td></tr>
</table>`)
    ).toBe('');
  });

  it('strips Downloads sections without removing inline download mentions', () => {
    const notes = `Patch release focused on smoother downloads.

### Fixed

- Download progress no longer gets stuck.

### Downloads

<table>
<tr><td>installer links</td></tr>
</table>`;

    expect(stripDownloadsSection(notes)).toBe(`Patch release focused on smoother downloads.

### Fixed

- Download progress no longer gets stuck.`);
  });

  it('strips html Downloads headings', () => {
    expect(stripDownloadsSection('Fixed\n\n<h2>Downloads</h2>\n<table>links</table>')).toBe(
      'Fixed'
    );
  });

  it('removes Downloads and its subsections until a same-level or higher-level heading', () => {
    const notes =
      'Summary.\n\n### Downloads\nlinks\n#### Linux\nmore links\n### macOS installation\nManual install required.\n\n### Downloads\nother links\n## Compatibility\nRequires macOS 13.';
    expect(stripDownloadsSection(notes)).toBe(
      'Summary.\n\n### macOS installation\nManual install required.\n\n## Compatibility\nRequires macOS 13.'
    );
  });

  it('preserves sibling HTML installation headings and higher-level Markdown sections', () => {
    const notes =
      '<h3 class="notes">Downloads</h3>\n<table>links</table>\n<h4>Windows</h4>\nmore links\n<h3>macOS installation</h3>\nInstall the DMG once.\n<h3>Downloads</h3>\nlinks\n## Requirements\nmacOS 13 or later.';
    expect(stripDownloadsSection(notes)).toBe(
      '<h3>macOS installation</h3>\nInstall the DMG once.\n## Requirements\nmacOS 13 or later.'
    );
  });

  it.each(['`', '~'])(
    'ignores section-like headings and short closing markers inside %s fences',
    (marker) => {
      const fence = marker.repeat(4);
      const shortFence = marker.repeat(3);
      const example = `${fence}markdown\n### Downloads\n<h2>Downloads</h2>\n${shortFence}\n## Still a code example\n${fence}`;
      const notes = `Example:\n${example}\n\n### Downloads\ninstaller links\n${fence}markdown\n### Fake boundary\n${shortFence}\n## Another fake boundary\n${fence}\n### Installation\nManual migration.`;
      expect(stripDownloadsSection(notes)).toBe(
        `Example:\n${example}\n\n### Installation\nManual migration.`
      );
    }
  );

  it('keeps subsequent version sections when the formatted changelog is filtered again', () => {
    const notes = formatUpdaterReleaseNotes([
      {
        version: '2.17.10',
        note: 'New changes.\n\n### Downloads\nlinks\n### macOS installation\nManual migration.',
      },
      {
        version: '2.17.6',
        note: 'Older changes.\n\n### Downloads\nold links\n## Compatibility\nOlder guidance.',
      },
    ]);
    expect(notes).toBe(
      '## v2.17.10\n\nNew changes.\n\n### macOS installation\nManual migration.\n\n## v2.17.6\n\nOlder changes.\n\n## Compatibility\nOlder guidance.'
    );
    expect(stripDownloadsSection(notes!)).toBe(notes);
  });

  it('formats full-changelog updater notes as a version list', () => {
    const notes = formatUpdaterReleaseNotes([
      {
        version: '2.0.2',
        note: `Fixed launch reliability.

### Downloads

<table>links</table>`,
      },
      {
        version: '2.0.1',
        note: 'Improved provider settings.',
      },
    ]);

    expect(notes).toBe(`## v2.0.2

Fixed launch reliability.

## v2.0.1

Improved provider settings.`);
  });

  it('strips Downloads from single-release string notes', () => {
    expect(formatUpdaterReleaseNotes('Fixed\n\n### Downloads\n<table>links</table>')).toBe('Fixed');
  });

  it('reads only the requested release note from full-changelog arrays', () => {
    expect(
      getUpdaterReleaseNoteForVersion(
        [
          { version: '2.0.2', note: 'Latest note' },
          { version: '2.0.1', note: 'Older [skip-updater] note' },
        ],
        'v2.0.2'
      )
    ).toBe('Latest note');
  });
});
