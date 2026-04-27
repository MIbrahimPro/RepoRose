'use strict';

/**
 * Extra scanner tests:
 *   - Non-code files appear in map with summarizable: false
 *   - Code files have summarizable: true
 *   - files_summarizable metadata count
 *   - CSS, SCSS, MD, media files are catalogued correctly
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { scan, getCategory, getLanguage } = require('../src/core/scanner');

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-extra-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function findFile(map, relPath) {
  return map.files.find((f) => f.path === relPath);
}

/* ------------------------------------------------------------------ */
/* Summarizable flag tests                                             */
/* ------------------------------------------------------------------ */

test('code files have summarizable: true', async () => {
  const repo = makeRepo({
    'src/app.js': 'export const x = 1;\n',
    'src/utils.ts': 'export function add(a: number, b: number) { return a + b; }\n',
  });
  try {
    const map = await scan(repo);
    const app = findFile(map, 'src/app.js');
    const utils = findFile(map, 'src/utils.ts');
    assert.ok(app, 'app.js should exist in map');
    assert.ok(utils, 'utils.ts should exist in map');
    assert.equal(app.summarizable, true);
    assert.equal(utils.summarizable, true);
    assert.equal(app.type, 'code');
    assert.equal(utils.type, 'code');
  } finally {
    cleanup(repo);
  }
});

test('non-code files appear in map with summarizable: false', async () => {
  const repo = makeRepo({
    'src/index.js': 'export const x = 1;\n',
    'README.md': '# My Project\n',
    'styles/main.css': 'body { color: red; }\n',
    'styles/theme.scss': '$color: blue;\n',
    'config.json': '{"key": "value"}\n',
    'package.json': '{"name": "test"}\n',
  });
  try {
    const map = await scan(repo);
    const paths = map.files.map(f => f.path);

    // All files should be in the map
    assert.ok(paths.includes('src/index.js'), 'JS file should be in map');
    assert.ok(paths.includes('README.md'), 'README should be in map');
    assert.ok(paths.includes('styles/main.css'), 'CSS should be in map');
    assert.ok(paths.includes('styles/theme.scss'), 'SCSS should be in map');

    // Code files are summarizable
    assert.equal(findFile(map, 'src/index.js').summarizable, true);

    // Non-code files are NOT summarizable
    assert.equal(findFile(map, 'README.md').summarizable, false);
    assert.equal(findFile(map, 'styles/main.css').summarizable, false);
    assert.equal(findFile(map, 'styles/theme.scss').summarizable, false);

    // Types are correct
    assert.equal(findFile(map, 'README.md').type, 'docs');
    assert.equal(findFile(map, 'styles/main.css').type, 'style');
    assert.equal(findFile(map, 'styles/theme.scss').type, 'style');
  } finally {
    cleanup(repo);
  }
});

test('files_summarizable metadata count is correct', async () => {
  const repo = makeRepo({
    'src/a.js': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 2;\n',
    'README.md': '# readme\n',
    'styles.css': '.x { color: red; }\n',
    'data.json': '{}',
  });
  try {
    const map = await scan(repo);
    // Only the 2 code files should be summarizable
    assert.equal(map.metadata.files_summarizable, 2);
    // Total files should include all non-binary entries
    assert.ok(map.metadata.files_analyzed >= 4, `Expected at least 4, got ${map.metadata.files_analyzed}`);
  } finally {
    cleanup(repo);
  }
});

test('binary, archive, and font files are hard-excluded from map', async () => {
  const repo = makeRepo({
    'src/app.js': 'export const x = 1;\n',
    'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'bundle.zip': Buffer.from([0x50, 0x4b]),
    'font.woff2': Buffer.from([0x00]),
    'icon.exe': Buffer.from([0x4d, 0x5a]),
  });
  try {
    const map = await scan(repo);
    const paths = map.files.map(f => f.path);
    assert.ok(paths.includes('src/app.js'));
    // Media IS included in aggressive mode now
    assert.ok(paths.includes('logo.png'), 'media should be in map');
    // But binary/archive/font are hard-excluded
    assert.ok(!paths.includes('bundle.zip'), 'archive should be excluded');
    assert.ok(!paths.includes('font.woff2'), 'font should be excluded');
    assert.ok(!paths.includes('icon.exe'), 'binary should be excluded');
  } finally {
    cleanup(repo);
  }
});

test('non-code files have empty functions, imports, exports arrays', async () => {
  const repo = makeRepo({
    'README.md': '# readme\nSome text.\n',
    'style.css': 'body { margin: 0; }\n',
  });
  try {
    const map = await scan(repo);
    const readme = findFile(map, 'README.md');
    const css = findFile(map, 'style.css');
    assert.ok(readme);
    assert.ok(css);
    assert.deepEqual(readme.functions, []);
    assert.deepEqual(readme.imports, []);
    assert.deepEqual(readme.exported, []);
    assert.deepEqual(css.functions, []);
    assert.deepEqual(css.imports, []);
    assert.deepEqual(css.exported, []);
  } finally {
    cleanup(repo);
  }
});

/* ------------------------------------------------------------------ */
/* Category and language helpers                                       */
/* ------------------------------------------------------------------ */

test('getCategory classifies known extensions correctly', () => {
  assert.equal(getCategory('app.js'), 'code');
  assert.equal(getCategory('app.ts'), 'code');
  assert.equal(getCategory('app.jsx'), 'code');
  assert.equal(getCategory('app.tsx'), 'code');
  assert.equal(getCategory('style.css'), 'style');
  assert.equal(getCategory('style.scss'), 'style');
  assert.equal(getCategory('style.less'), 'style');
  assert.equal(getCategory('readme.md'), 'docs');
  assert.equal(getCategory('img.png'), 'media');
  assert.equal(getCategory('img.svg'), 'media');
  assert.equal(getCategory('data.json'), 'config');
  assert.equal(getCategory('schema.sql'), 'database');
  assert.equal(getCategory('app.exe'), 'binary');
  assert.equal(getCategory('lib.zip'), 'archive');
  assert.equal(getCategory('font.woff2'), 'font');
  assert.equal(getCategory('.env'), 'config');
  assert.equal(getCategory('.env.example'), 'config');
  assert.equal(getCategory('Dockerfile'), 'config');
  assert.equal(getCategory('unknown.xyz'), 'other');
});

test('getLanguage returns correct language identifiers', () => {
  assert.equal(getLanguage('app.js'), 'javascript');
  assert.equal(getLanguage('app.ts'), 'typescript');
  assert.equal(getLanguage('app.jsx'), 'javascriptreact');
  assert.equal(getLanguage('app.tsx'), 'typescriptreact');
  assert.equal(getLanguage('style.css'), 'css');
  assert.equal(getLanguage('style.scss'), 'scss');
  assert.equal(getLanguage('readme.md'), 'markdown');
  assert.equal(getLanguage('data.json'), 'json');
  assert.equal(getLanguage('.env'), 'dotenv');
  assert.equal(getLanguage('.env.local'), 'dotenv');
  assert.equal(getLanguage('unknown.xyz'), 'unknown');
});
