const { report, fail } = require('./index.js');

report().catch(fail);
