// three-node cycle: c -> d -> e -> c
const d = require('./d');
module.exports = {name: 'c', d};
