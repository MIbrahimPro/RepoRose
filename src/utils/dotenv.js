'use strict';

// tiny .env loader — doesnt need the dotenv npm package
// parses KEY=VALUE pairs and puts them into process.env
// wont overwrite stuff thats already set (cuz CLI flags should win)

const fs = require('fs');
const path = require('path');

// supports:
// - blank lines and # comments
// - export KEY=VALUE (the bash style)
// - quoted values like KEY="value"
// - inline comments after unquoted values

// takes a path to .env file, returns parsed key/value object
function loadDotenv(filePath) {
  const file = filePath || path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return {};

  const out = {};
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*export\s+/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // Strip trailing inline comment for unquoted values
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out[key] = value;
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
  return out;
}

module.exports = { loadDotenv };
