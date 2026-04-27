'use strict';

// handles .gitignore parsing and matching
// walks the repo finding all .gitignore files and combines them
// also has some hardcoded ignores that always apply

const fs = require('fs');
const path = require('path');
const ignore = require('ignore');

// these are always ignored no matter what .gitignore says
// node_modules is here cuz we track it via package.json, not by scanning
const ALWAYS_IGNORE = ['.git', 'node_modules', '.reporose'];

// rewrites a .gitignore pattern so it works from repo root
// cuz if packages/foo/.gitignore has "*.log", that should match
// packages/foo/*.log, not just *.log from root

// takes the raw line and the directory path relative to root
// returns the fixed up pattern
function rewritePattern(line, dirRel) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return line;
  const negate = trimmed.startsWith('!');
  let pat = negate ? trimmed.slice(1) : trimmed;

  // Patterns starting with `/` are anchored to the dir of the .gitignore.
  if (pat.startsWith('/')) pat = pat.slice(1);

  if (!dirRel) return (negate ? '!' : '') + pat;

  // If the pattern contains no slash (other than a trailing one) it should
  // match anywhere below the dir, so leave a `**/` style match. The simplest
  // and safest rewrite is to anchor it to the directory path.
  const prefixed = `${dirRel}/${pat}`;
  return (negate ? '!' : '') + prefixed;
}

function readGitignore(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return null;
  }
}

// builds an ignore matcher for the whole repo
// walks all subdirectories looking for .gitignore files
// combines them all into one big matcher
// returns the ignore object you can test paths against
function loadIgnore(repoPath) {
  const ig = ignore();
  ig.add(ALWAYS_IGNORE);

  function loadFromDir(dir) {
    const giPath = path.join(dir, '.gitignore');
    const content = readGitignore(giPath);
    if (content !== null) {
      const rel = path.relative(repoPath, dir).split(path.sep).join('/');
      const rewritten = content
        .split(/\r?\n/)
        .map((line) => rewritePattern(line, rel))
        .join('\n');
      ig.add(rewritten);
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (ALWAYS_IGNORE.includes(entry.name)) continue;
      const sub = path.join(dir, entry.name);
      const subRel = path.relative(repoPath, sub).split(path.sep).join('/');
      // Don't descend into already-ignored directories when collecting patterns.
      if (subRel && ig.ignores(subRel + '/')) continue;
      loadFromDir(sub);
    }
  }

  loadFromDir(repoPath);
  return ig;
}

// checks if a path should be ignored
// takes the ignore object, repo path, absolute path, and whether its a directory
// returns true if it matches any ignore pattern
function isIgnored(ig, repoPath, absPath, isDir) {
  const rel = path.relative(repoPath, absPath).split(path.sep).join('/');
  if (!rel) return false;
  return ig.ignores(isDir ? rel + '/' : rel);
}

module.exports = {
  loadIgnore,
  isIgnored,
  ALWAYS_IGNORE,
};
