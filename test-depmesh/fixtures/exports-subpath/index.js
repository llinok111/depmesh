'use strict';

// A valid subpath export: resolvable by Node through the package's `exports`
// map, but not by "does this file exist on disk" style resolution.
const adapter = require('fake-pkg/adapter');

module.exports = adapter;
