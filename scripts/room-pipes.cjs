'use strict';
// Loaded only by the trusted native host, inside its AppContainer. The native
// module checks the actual OS token before modifying its own process imports.
const binding = require('./room-pipe-compat.node');
if (binding.installed !== true) throw new Error('Native pipe compatibility was not installed');
