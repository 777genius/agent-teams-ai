'use strict';

const path = require('node:path');

module.exports = require(path.join(
  __dirname,
  'build',
  'Release',
  'desktop_file_lock_native.node'
));
