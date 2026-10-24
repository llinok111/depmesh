'use strict';

// A bare specifier for a package that is not installed. The graph cannot expand
// it, but nothing in the project's own source is missing, so this must be a
// warning rather than a failure.
const format = require('some-package-that-is-not-installed');
const local = require('./local');

module.exports = {format, local};
