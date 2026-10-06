#!/usr/bin/env node
// Offline protocol peer: these media requirements are independent of the downloader.
const [operation, endpoint, headerFlag, accept, ...extra] = process.argv.slice(2);
const actions =
  endpoint === 'repos/TEST/transport/actions/artifacts/101/zip' ||
  endpoint === 'repos/TEST/transport/actions/artifacts/102/zip';
const release = endpoint === 'repos/TEST/transport/releases/assets/201';
if (operation !== 'api' || headerFlag !== '-H' || extra.length !== 0 || (!actions && !release)) {
  process.stderr.write('Unexpected protocol request\n');
  process.exit(99);
}
if (accept !== (actions ? 'Accept: application/json' : 'Accept: application/octet-stream')) {
  process.stderr.write('HTTP 415: unsupported Accept header\n');
  process.exit(1);
}
process.stdout.write(
  Buffer.from(
    actions
      ? 'UEsDBBQAAAAAAAAAIVz6wKB7GAAAABgAAAAOAAAAdHJhbnNwb3J0Lmpzb257InRyYW5zcG9ydCI6ImFjdGlvbnMifQpQSwECFAMUAAAAAAAAACFc+sCgexgAAAAYAAAADgAAAAAAAAAAAAAAgAEAAAAAdHJhbnNwb3J0Lmpzb25QSwUGAAAAAAEAAQA8AAAARAAAAAAA'
      : 'AP+AUEsADQo=',
    'base64'
  )
);
