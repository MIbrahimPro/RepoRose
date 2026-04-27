'use strict';

/**
secure secret storage — handles API keys and stuff

tries to be fancy first (OS keychain via keytar)
if that fails, falls back to a JSON file in ~/.reporose/

priority:
1. process.env (if you already set it)
2. OS keychain (the proper way)
3. JSON file (the "i give up" way)

JSON file gets chmod 0600 so other users cant read it
but still,,, keychain is better if you can install keytar
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SECRETS_FILE = path.join(os.homedir(), '.reporose', 'secrets.json');
const SERVICE_NAME = 'reporose';

let keytar = null;
let keytarLoadAttempted = false;
let jsonFallbackNoticeShown = false;

function loadKeytar() {
  if (keytarLoadAttempted) return keytar;
  keytarLoadAttempted = true;
  try {
    // eslint-disable-next-line global-require
    keytar = require('keytar');
  } catch {
    keytar = null;
  }
  return keytar;
}

function ensureSecretsDir() {
  const dir = path.dirname(SECRETS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function readSecretsFile() {
  try {
    if (!fs.existsSync(SECRETS_FILE)) return {};
    const data = fs.readFileSync(SECRETS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function writeSecretsFile(secrets) {
  ensureSecretsDir();
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

function showJsonFallbackNotice() {
  if (jsonFallbackNoticeShown) return;
  jsonFallbackNoticeShown = true;
  // eslint-disable-next-line no-console
  console.log(
    '[reporose] Note: Storing secrets in ~/.reporose/secrets.json (chmod 0600). ' +
      'Install keytar for OS keychain integration: npm install -g keytar'
  );
}

// gets a secret by name
// checks env first, then keychain, then JSON file
// returns the value or null if not found
function getSecret(envName) {
  // 1. Check process.env first (user may have exported it)
  const envValue = process.env[envName];
  if (envValue) return envValue;

  // 2. Try keytar
  const kt = loadKeytar();
  if (kt) {
    try {
      const value = kt.getPassword(SERVICE_NAME, envName);
      if (value) {
        // Temporarily export for this process
        process.env[envName] = value;
        return value;
      }
    } catch {
      // Fall through to JSON
    }
  }

  // 3. JSON fallback
  const secrets = readSecretsFile();
  const jsonValue = secrets[envName] || null;
  if (jsonValue) {
    process.env[envName] = jsonValue;
  }
  return jsonValue;
}

// saves a secret
// tries keychain first, falls back to JSON
// also sets it in process.env so its available immediately
function setSecret(envName, value) {
  // Always export for current process
  process.env[envName] = value;

  // Try keytar
  const kt = loadKeytar();
  if (kt) {
    try {
      kt.setPassword(SERVICE_NAME, envName, value);
      return;
    } catch {
      // Fall through to JSON
    }
  }

  // JSON fallback
  showJsonFallbackNotice();
  const secrets = readSecretsFile();
  secrets[envName] = value;
  writeSecretsFile(secrets);
}

// deletes a secret from everywhere
// removes from env, keychain, and JSON file
function deleteSecret(envName) {
  delete process.env[envName];

  const kt = loadKeytar();
  if (kt) {
    try {
      kt.deletePassword(SERVICE_NAME, envName);
    } catch {
      // Ignore
    }
  }

  const secrets = readSecretsFile();
  if (secrets[envName]) {
    delete secrets[envName];
    writeSecretsFile(secrets);
  }
}

// lists all stored secret names
// only returns names, not the actual values (cuz that would be bad)
function listSecrets() {
  const names = new Set();

  // From keytar
  const kt = loadKeytar();
  if (kt) {
    try {
      const creds = kt.findCredentials(SERVICE_NAME);
      for (const cred of creds) {
        names.add(cred.account);
      }
    } catch {
      // Ignore
    }
  }

  // From JSON
  const secrets = readSecretsFile();
  for (const name of Object.keys(secrets)) {
    names.add(name);
  }

  return Array.from(names).sort();
}

// checks if keytar (the keychain library) is installed
function hasKeytar() {
  return !!loadKeytar();
}

module.exports = {
  getSecret,
  setSecret,
  deleteSecret,
  listSecrets,
  hasKeytar,
  SECRETS_FILE,
};
