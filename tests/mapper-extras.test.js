'use strict';

/**
 * Extra mapper tests:
 *   - Transitive importance propagation
 *   - Isolated files get score 0
 *   - Entry-point files get boosted scores
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { scan } = require('../src/core/scanner');
const { mapDependencies } = require('../src/core/mapper');

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-mapper-'));
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

async function scanAndMap(repoFiles) {
  const repo = makeRepo(repoFiles);
  const map = await scan(repo);
  mapDependencies(map);
  return { repo, map };
}

/* ------------------------------------------------------------------ */
/* Transitive importance propagation                                   */
/* ------------------------------------------------------------------ */

test('entry-point file importing a hub gets a non-zero importance score', async () => {
  // main.jsx imports App.jsx, which is imported by nobody else.
  // App.jsx imports 3 utility files. Without transitive propagation,
  // main.jsx would score ~0 because nobody imports main.
  const { repo, map } = await scanAndMap({
    'src/main.jsx': "import App from './App';\nApp();\n",
    'src/App.jsx': [
      "import { Header } from './Header';",
      "import { Footer } from './Footer';",
      "import { Sidebar } from './Sidebar';",
      "export default function App() { return Header() + Footer() + Sidebar(); }",
    ].join('\n') + '\n',
    'src/Header.jsx': 'export function Header() { return "h"; }\n',
    'src/Footer.jsx': 'export function Footer() { return "f"; }\n',
    'src/Sidebar.jsx': 'export function Sidebar() { return "s"; }\n',
  });
  try {
    const main = findFile(map, 'src/main.jsx');
    const app = findFile(map, 'src/App.jsx');
    assert.ok(main, 'main.jsx should be in the map');
    assert.ok(app, 'App.jsx should be in the map');

    // main.jsx should have a meaningful importance score (>0)
    // because it imports App.jsx which is the hub
    assert.ok(
      main.importance_score > 0,
      `main.jsx should have importance > 0, got ${main.importance_score}`,
    );

    // App.jsx should still be the most important (highest incoming + betweenness)
    assert.ok(
      app.importance_score >= main.importance_score,
      `App.jsx (${app.importance_score}) should be >= main.jsx (${main.importance_score})`,
    );
  } finally {
    cleanup(repo);
  }
});

test('completely isolated files have importance_score 0', async () => {
  const { repo, map } = await scanAndMap({
    'src/a.js': 'export const a = 1;\n',
    'src/b.js': 'export const b = 2;\n',
    // No imports between them — both are isolated
  });
  try {
    const a = findFile(map, 'src/a.js');
    const b = findFile(map, 'src/b.js');
    assert.equal(a.importance_score, 0, 'isolated file a should have score 0');
    assert.equal(b.importance_score, 0, 'isolated file b should have score 0');
  } finally {
    cleanup(repo);
  }
});

test('non-code files in the map participate in networks but not importance', async () => {
  const { repo, map } = await scanAndMap({
    'src/app.js': "import './utils';\nexport const app = 1;\n",
    'src/utils.js': 'export const utils = 1;\n',
    'README.md': '# readme\n',
    'style.css': 'body { margin: 0; }\n',
  });
  try {
    const readme = findFile(map, 'README.md');
    const css = findFile(map, 'style.css');
    assert.ok(readme, 'README should be in the map');
    assert.ok(css, 'CSS should be in the map');
    // Non-code files should have importance 0
    assert.equal(readme.importance_score, 0);
    assert.equal(css.importance_score, 0);
    // They should be in the isolated network
    const isolated = map.networks.find(n => n.id === 'network_isolated');
    if (isolated) {
      assert.ok(
        isolated.files.includes(readme.id) || isolated.files.includes(css.id),
        'non-code files should be in isolated network',
      );
    }
  } finally {
    cleanup(repo);
  }
});

test('deep transitive chain: A->B->C->D gives A non-zero importance', async () => {
  const { repo, map } = await scanAndMap({
    'src/a.js': "import './b';\nexport const a = 1;\n",
    'src/b.js': "import './c';\nexport const b = 1;\n",
    'src/c.js': "import './d';\nexport const c = 1;\n",
    'src/d.js': 'export const d = 1;\n',
  });
  try {
    const a = findFile(map, 'src/a.js');
    const d = findFile(map, 'src/d.js');
    assert.ok(a.importance_score > 0, `a should have score > 0, got ${a.importance_score}`);
    assert.ok(d.importance_score > 0, `d should have score > 0, got ${d.importance_score}`);
  } finally {
    cleanup(repo);
  }
});

/* ------------------------------------------------------------------ */
/* Statistics validation                                               */
/* ------------------------------------------------------------------ */

test('statistics include non-code files in total_files count', async () => {
  const { repo, map } = await scanAndMap({
    'src/app.js': 'export const x = 1;\n',
    'README.md': '# readme\n',
    'style.css': 'body {}\n',
  });
  try {
    assert.ok(
      map.statistics.total_files >= 3,
      `total_files should include all files, got ${map.statistics.total_files}`,
    );
  } finally {
    cleanup(repo);
  }
});
