'use strict';

import('./app.mjs').catch((error) => {
  console.error('Failed to start Etlaala Hostinger MCP:', error?.stack || error);
  process.exit(1);
});
