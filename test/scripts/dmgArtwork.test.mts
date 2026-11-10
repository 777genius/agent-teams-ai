import assert from 'node:assert/strict';
import test from 'node:test';
import { iconPosition } from '../../scripts/ci/verify-dmg-artwork.mts';

test('reads Finder Iloc coordinates independently from expected layout', () => {
  const name = Buffer.from('Applications', 'utf16le');
  name.swap16();
  const data = Buffer.alloc(20);
  data.writeUInt32BE(16, 0);
  data.writeUInt32BE(571, 4);
  data.writeUInt32BE(245, 8);
  const record = Buffer.concat([Buffer.alloc(8), name, Buffer.from('Ilocblob'), data]);
  assert.deepEqual(iconPosition(record, 'Applications'), { x: 571, y: 245 });
  assert.throws(() => iconPosition(record, 'Wrong icon'));
  record.writeUInt32BE(8, record.length - 20);
  assert.throws(() => iconPosition(record, 'Applications'));
});
