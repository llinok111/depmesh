// relative import whose target does not exist on disk
const gone = require('./does-not-exist');
// bare specifier that is not installed
const nobody = require('this-package-is-not-installed');
module.exports = {gone, nobody};
