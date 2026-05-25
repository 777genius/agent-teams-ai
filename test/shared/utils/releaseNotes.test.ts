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
