#!/usr/bin/env node
'use strict';

const path = require('path');
const { loadDotenv } = require('../src/utils/dotenv');
const { run } = require('../src/cli/commands');

// Load .env from the cwd (target repo) so users can drop OPENROUTER_API_KEY etc.
loadDotenv(path.resolve(process.cwd(), '.env'));

const argv = process.argv.slice(2);

run(argv)
  .then((code) => {
    if (typeof code === 'number') process.exit(code);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[reporose] ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
