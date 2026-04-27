'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { scan } = require('../src/core/scanner');
const { analyze, map: mapCmd } = require('../src/cli/commands');
const {
  mapDependencies,
  resolveFileImport,
  buildFileIndex,
  findSCCs,
  betweennessCentrality,
  WEIGHTS,
} = require('../src/core/mapper');

/* ------------------------------------------------------------------ */
/* Fixture helpers                                                     */
/* ------------------------------------------------------------------ */

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-phase2-'));
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

async function scanAndMap(repoFiles, options = {}) {
  const repo = makeRepo(repoFiles);
  const map = await scan(repo, options);
  mapDependencies(map);
  return { repo, map };
}

function findFile(map, relPath) {
  return map.files.find((f) => f.path === relPath);
}

function findLink(map, fromId, toId) {
  return map.links.find(
    (l) => l.from_file_id === fromId && (l.to_file_id === toId || l.to_package_id === toId),
  );
}

/* ------------------------------------------------------------------ */
/* resolveFileImport                                                   */
/* ------------------------------------------------------------------ */

test('resolveFileImport handles extension fallbacks and index files', () => {
  const files = [
    { id: 'f1', path: 'src/index.ts' },
    { id: 'f2', path: 'src/utils/helpers.ts' },
    { id: 'f3', path: 'src/components/Button/index.tsx' },
  ];
  const idx = buildFileIndex(files);

  assert.equal(resolveFileImport(idx, 'src/index.ts', './utils/helpers').id, 'f2');
  assert.equal(resolveFileImport(idx, 'src/index.ts', './components/Button').id, 'f3');
  assert.equal(resolveFileImport(idx, 'src/utils/helpers.ts', '../index').id, 'f1');
  assert.equal(resolveFileImport(idx, 'src/index.ts', './does-not-exist'), null);
});

/* ------------------------------------------------------------------ */
/* Direct + package links                                              */
/* ------------------------------------------------------------------ */

test('builds direct file-to-file links with weight = 100 * frequency', async () => {
  const { repo, map } = await scanAndMap({
    'src/a.js': "import { b } from './b';\nimport { b as b2 } from './b';\nexport const a = b + b2;\n",
    'src/b.js': 'export const b = 1;\n',
  });
  try {
    const a = findFile(map, 'src/a.js');
    const b = findFile(map, 'src/b.js');
    const link = findLink(map, a.id, b.id);
    assert.ok(link, 'a -> b link should exist');
    assert.equal(link.type, 'direct');
    assert.equal(link.frequency, 2, 'two import statements -> frequency 2');
    assert.equal(link.weight, WEIGHTS.DIRECT * 2);
    assert.equal(link.location.file, 'src/a.js');
    assert.equal(typeof link.location.line, 'number');
  } finally {
    cleanup(repo);
  }
});

test('builds package links and computes 80 * usage_count weight', async () => {
  const { repo, map } = await scanAndMap({
    'package.json': JSON.stringify({
      name: 'demo',
      dependencies: { react: '18.0.0', lodash: '4.0.0' },
    }),
    'src/a.js': "import React from 'react';\nimport _ from 'lodash/fp';\nexport default React;\n",
    'src/b.js': "import React from 'react';\nexport default React;\n",
  });
  try {
    const react = map.packages.find((p) => p.name === 'react');
    assert.equal(react.usage_count, 2, 'react imported by 2 files');
    const lodash = map.packages.find((p) => p.name === 'lodash');
    assert.equal(lodash.usage_count, 1, 'lodash subpath import resolved to root pkg');

    const a = findFile(map, 'src/a.js');
    const aReactLink = findLink(map, a.id, react.id);
    assert.ok(aReactLink);
    assert.equal(aReactLink.type, 'package');
    assert.equal(aReactLink.weight, WEIGHTS.PACKAGE * react.usage_count);
  } finally {
    cleanup(repo);
  }
});

/* ------------------------------------------------------------------ */
/* Indirect (2-hop) links                                              */
/* ------------------------------------------------------------------ */

test('creates indirect A->C link when A->B->C exists (no direct A->C)', async () => {
  const { repo, map } = await scanAndMap({
    'src/a.js': "import { b } from './b';\nexport const a = b;\n",
    'src/b.js': "import { c } from './c';\nexport const b = c;\n",
    'src/c.js': 'export const c = 1;\n',
  });
  try {
    const a = findFile(map, 'src/a.js');
    const b = findFile(map, 'src/b.js');
    const c = findFile(map, 'src/c.js');

    const ab = findLink(map, a.id, b.id);
    const bc = findLink(map, b.id, c.id);
    const ac = findLink(map, a.id, c.id);

    assert.equal(ab.type, 'direct');
    assert.equal(ab.weight, WEIGHTS.DIRECT * 1);
    assert.equal(bc.type, 'direct');
    assert.equal(ac.type, 'indirect');
    assert.equal(ac.weight, WEIGHTS.INDIRECT * ac.frequency);
    assert.ok(ac.frequency >= 1);
  } finally {
    cleanup(repo);
  }
});

test('does not create indirect link if a direct link already exists', async () => {
  const { repo, map } = await scanAndMap({
    'src/a.js': "import { b } from './b';\nimport { c } from './c';\nexport const a = b + c;\n",
    'src/b.js': "import { c } from './c';\nexport const b = c;\n",
    'src/c.js': 'export const c = 1;\n',
  });
  try {
    const a = findFile(map, 'src/a.js');
    const c = findFile(map, 'src/c.js');
    const ac = findLink(map, a.id, c.id);
    assert.equal(ac.type, 'direct', 'direct A->C should win over indirect');
  } finally {
    cleanup(repo);
  }
});

/* ------------------------------------------------------------------ */
/* Cycle detection                                                     */
/* ------------------------------------------------------------------ */

test('detects circular dependency (A <-> B) and flags links', async () => {
  const { repo, map } = await scanAndMap({
    'src/a.js': "import { b } from './b';\nexport const a = b;\n",
    'src/b.js': "import { a } from './a';\nexport const b = a;\n",
  });
  try {
    assert.equal(map.circular_dependencies.length, 1);
    const cycle = map.circular_dependencies[0];
    assert.equal(cycle.risk_level, 'high');
    assert.ok(typeof cycle.recommendation === 'string' && cycle.recommendation.length > 0);
    const a = findFile(map, 'src/a.js');
    const b = findFile(map, 'src/b.js');
    assert.deepEqual(new Set(cycle.cycle), new Set([a.id, b.id]));
    assert.equal(cycle.files_involved.length, 2);

    const ab = findLink(map, a.id, b.id);
    const ba = findLink(map, b.id, a.id);
    assert.equal(ab.type, 'circular');
    assert.equal(ab.is_circular, true);
    assert.equal(ab.weight, WEIGHTS.CIRCULAR);
    assert.equal(ba.type, 'circular');
    assert.equal(ba.weight, WEIGHTS.CIRCULAR);
  } finally {
    cleanup(repo);
  }
});

test('detects 3-file cycle (A -> B -> C -> A)', async () => {
  const { repo, map } = await scanAndMap({
    'src/a.js': "import './b';\nexport const a = 1;\n",
    'src/b.js': "import './c';\nexport const b = 1;\n",
    'src/c.js': "import './a';\nexport const c = 1;\n",
  });
  try {
    assert.equal(map.circular_dependencies.length, 1);
    assert.equal(map.circular_dependencies[0].cycle.length, 3);
  } finally {
    cleanup(repo);
  }
});

test('findSCCs identifies cycles in directed graphs', () => {
  const adj = new Map([
    ['a', ['b']],
    ['b', ['c']],
    ['c', ['a']],
    ['d', ['e']],
    ['e', []],
  ]);
  const sccs = findSCCs(['a', 'b', 'c', 'd', 'e'], adj);
  const cyclic = sccs.filter((s) => s.length > 1);
  assert.equal(cyclic.length, 1);
  assert.deepEqual(new Set(cyclic[0]), new Set(['a', 'b', 'c']));
});

/* ------------------------------------------------------------------ */
/* Importance score                                                    */
/* ------------------------------------------------------------------ */

test('importance scores are scaled to 0..10 and rank hub files highest', async () => {
  const { repo, map } = await scanAndMap({
    'src/hub.js': 'export const hub = 1;\n',
    'src/a.js': "import { hub } from './hub';\nexport const a = hub;\n",
    'src/b.js': "import { hub } from './hub';\nexport const b = hub;\n",
    'src/c.js': "import { hub } from './hub';\nexport const c = hub;\n",
    'README.md': '# unused docs\n',
  }, { includeDocs: true, aggressive: false });
  try {
    for (const f of map.files) {
      assert.ok(f.importance_score >= 0 && f.importance_score <= 10, `score ${f.importance_score} out of range for ${f.path}`);
    }
    const hub = findFile(map, 'src/hub.js');
    const a = findFile(map, 'src/a.js');
    const readme = findFile(map, 'README.md');

    assert.equal(hub.usage_count, 3, 'hub imported 3 times');
    assert.equal(hub.incoming_connections, 3);
    assert.equal(a.outgoing_connections, 1);
    assert.equal(readme.importance_score, 0, 'isolated file gets 0');
    assert.ok(hub.importance_score > a.importance_score, 'hub more important than a');
    assert.equal(map.statistics.most_important_file.file_id, hub.id);
  } finally {
    cleanup(repo);
  }
});

test('betweennessCentrality computes positive scores for bridge nodes', () => {
  // Path graph a -> b -> c. b should be a bridge.
  const adj = new Map([
    ['a', ['b']],
    ['b', ['c']],
    ['c', []],
  ]);
  const cb = betweennessCentrality(['a', 'b', 'c'], adj);
  assert.ok(cb.get('b') > 0);
  assert.equal(cb.get('a'), 0);
  assert.equal(cb.get('c'), 0);
});

/* ------------------------------------------------------------------ */
/* Networks                                                            */
/* ------------------------------------------------------------------ */

test('builds main + isolated networks and counts edges', async () => {
  const { repo, map } = await scanAndMap({
    'src/a.js': "import './b';\nexport const a = 1;\n",
    'src/b.js': 'export const b = 1;\n',
    'docs/orphan.md': '# orphan\n',
  }, { includeDocs: true, aggressive: false });
  try {
    const main = map.networks.find((n) => n.id === 'network_main');
    const isolated = map.networks.find((n) => n.id === 'network_isolated');
    assert.ok(main, 'should have main network');
    assert.ok(isolated, 'should have isolated network');

    const a = findFile(map, 'src/a.js');
    const b = findFile(map, 'src/b.js');
    const orphan = findFile(map, 'docs/orphan.md');

    assert.ok(main.files.includes(a.id));
    assert.ok(main.files.includes(b.id));
    assert.ok(isolated.files.includes(orphan.id));
    assert.equal(main.type, 'active');
    assert.equal(isolated.type, 'isolated');
    assert.ok(main.edge_count >= 1);
  } finally {
    cleanup(repo);
  }
});

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

test('statistics block has all required fields', async () => {
  const { repo, map } = await scanAndMap({
    'src/a.js': "import './b';\nexport function f() {}\n",
    'src/b.js': "export function g() {}\n",
  });
  try {
    const s = map.statistics;
    assert.equal(typeof s.total_files, 'number');
    assert.equal(typeof s.total_functions, 'number');
    assert.equal(typeof s.total_connections, 'number');
    assert.equal(typeof s.circular_dependency_count, 'number');
    assert.equal(typeof s.network_density, 'number');
    assert.equal(typeof s.average_file_importance, 'number');
    assert.ok(s.most_important_file);
    assert.equal(typeof s.most_important_file.file_id, 'string');
    assert.equal(typeof s.most_important_file.importance, 'number');
    assert.equal(s.total_files, map.files.length);
    assert.ok(s.network_density >= 0 && s.network_density <= 1);
  } finally {
    cleanup(repo);
  }
});

/* ------------------------------------------------------------------ */
/* CLI integration                                                     */
/* ------------------------------------------------------------------ */

test('analyze CLI runs Phase 2 by default and produces enriched JSON', async () => {
  const repo = makeRepo({
    'package.json': JSON.stringify({ name: 'demo' }),
    'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
    'src/b.ts': 'export const b = 1;\n',
  });
  try {
    const { outputPath, map } = await analyze(repo, { silent: true });
    assert.ok(fs.existsSync(outputPath));
    assert.ok(Array.isArray(map.links) && map.links.length >= 1);
    assert.ok(Array.isArray(map.networks) && map.networks.length >= 1);
    assert.ok(typeof map.statistics.total_files === 'number');

    // Disk content matches in-memory map
    const onDisk = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(onDisk.links.length, map.links.length);
  } finally {
    cleanup(repo);
  }
});

test('analyze --no-map skips Phase 2', async () => {
  const repo = makeRepo({
    'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
    'src/b.ts': 'export const b = 1;\n',
  });
  try {
    const { map } = await analyze(repo, { silent: true, map: false });
    assert.deepEqual(map.links, []);
    assert.deepEqual(map.networks, []);
    assert.deepEqual(map.circular_dependencies, []);
  } finally {
    cleanup(repo);
  }
});

test('map CLI command enriches an existing analyze output', async () => {
  const repo = makeRepo({
    'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
    'src/b.ts': 'export const b = 1;\n',
  });
  try {
    await analyze(repo, { silent: true, map: false });
    const { outputPath, map } = await mapCmd(repo, { silent: true });
    assert.ok(fs.existsSync(outputPath));
    assert.ok(map.links.length >= 1);
    assert.ok(map.statistics.total_files >= 2);
  } finally {
    cleanup(repo);
  }
});

test('mapDependencies leaves an empty graph in a sane state', () => {
  const map = {
    files: [],
    packages: [],
    links: [],
    networks: [],
    circular_dependencies: [],
    statistics: {},
  };
  mapDependencies(map);
  assert.deepEqual(map.links, []);
  assert.deepEqual(map.networks, []);
  assert.deepEqual(map.circular_dependencies, []);
  assert.equal(map.statistics.total_files, 0);
  assert.equal(map.statistics.total_connections, 0);
});
