'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const {
  createApp,
  start,
  buildFileDetail,
  findNode,
  listenWithFallback,
} = require('../src/server/server');
const { search, tokenize } = require('../src/server/search');
const { loadDotenv } = require('../src/utils/dotenv');
const { splitAndSaveMap } = require('../src/core/storage');

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-phase4-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}
function cleanup(root) { fs.rmSync(root, { recursive: true, force: true }); }

function fakeMap() {
  return {
    metadata: { generated_at: '2024-01-01T00:00:00Z', files_analyzed: 3 },
    files: [
      {
        id: 'file_001', name: 'auth.ts', path: 'src/auth.ts', type: 'code', language: 'typescript',
        size_bytes: 200, hash: 'a',
        description: 'Handles authentication and user login flows.',
        functions: [
          { id: 'fn_001_01', name: 'login', type: 'function', signature: 'function login(user: User)', parameters: ['user'], return_type: 'Promise<Token>', description: 'Authenticates a user and returns a token.' },
        ],
        imports: [{ source: './db', type: 'file', line_imported: 1 }],
        exported: [{ name: 'login', type: 'function' }],
        importance_score: 9.2, usage_count: 23,
        incoming_connections: 23, outgoing_connections: 8,
      },
      {
        id: 'file_002', name: 'db.ts', path: 'src/db.ts', type: 'code', language: 'typescript',
        size_bytes: 100, hash: 'b',
        description: 'Database connection helpers.',
        functions: [
          { id: 'fn_002_01', name: 'connect', type: 'function', signature: 'function connect()', parameters: [], return_type: 'Promise<void>', description: 'Opens a database connection.' },
        ],
        imports: [{ source: 'pg', type: 'package', line_imported: 1 }],
        exported: [{ name: 'connect', type: 'function' }],
        importance_score: 5.0, usage_count: 4,
        incoming_connections: 1, outgoing_connections: 0,
      },
      {
        id: 'file_003', name: 'README.md', path: 'README.md', type: 'docs', language: 'markdown',
        size_bytes: 80, hash: 'c',
        description: 'Project readme.',
        functions: [], imports: [], exported: [],
        importance_score: 0, usage_count: 0,
        incoming_connections: 0, outgoing_connections: 0,
      },
    ],
    packages: [
      { id: 'pkg_001', name: 'pg', type: 'production', version: '8.0.0', usage_count: 1 },
    ],
    links: [
      { id: 'link_0001', from_file_id: 'file_001', to_file_id: 'file_002', type: 'direct', frequency: 1, weight: 100, is_circular: false, location: { file: 'src/auth.ts', line: 1 } },
      { id: 'link_0002', from_file_id: 'file_002', to_package_id: 'pkg_001', type: 'package', frequency: 1, weight: 80 },
    ],
    networks: [
      { id: 'network_main', name: 'Main Codebase', type: 'active', node_count: 2, edge_count: 1, files: ['file_001', 'file_002'] },
      { id: 'network_isolated', name: 'Unused', type: 'isolated', node_count: 1, edge_count: 0, files: ['file_003'] },
    ],
    circular_dependencies: [],
    statistics: { total_files: 3, total_functions: 2 },
  };
}

function writeFakeMap(root) {
  const { indexPath } = splitAndSaveMap(root, fakeMap(), '.reporose');
  return indexPath;
}

async function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, body, headers: res.headers });
        }
      });
    }).on('error', reject);
  });
}

async function getRaw(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* tokenize / search                                                   */
/* ------------------------------------------------------------------ */

test('tokenize strips stopwords and splits', () => {
  assert.deepEqual(tokenize('How does login work'), ['login']);
  assert.deepEqual(tokenize('where is auth.ts'), ['auth.ts']);
  // Slashes are preserved on purpose so path-style queries like `lodash/fp` work.
  assert.deepEqual(tokenize('lodash/fp react'), ['lodash/fp', 'react']);
  assert.deepEqual(tokenize('handle parse user'), ['handle', 'parse', 'user']);
  assert.deepEqual(tokenize(''), []);
});

test('search finds files by exact name', () => {
  const map = fakeMap();
  const result = search(map, 'auth.ts');
  assert.ok(result.results.length > 0);
  assert.equal(result.results[0].kind, 'file');
  assert.equal(result.results[0].name, 'auth.ts');
});

test('search supports natural-language questions', () => {
  const map = fakeMap();
  const result = search(map, 'How does login work');
  assert.ok(result.results.length > 0);
  // Function login or auth file should rank top
  const top = result.results[0];
  assert.ok(top.name.toLowerCase().includes('login') || top.name.toLowerCase().includes('auth'));
});

test('search ranks by description match when name does not contain query', () => {
  const map = fakeMap();
  const result = search(map, 'authentication');
  assert.ok(result.results.length > 0);
  assert.equal(result.results[0].id, 'file_001'); // auth.ts description mentions "authentication"
});

test('search caps results at limit', () => {
  const map = fakeMap();
  const result = search(map, 'function', { limit: 1 });
  assert.equal(result.results.length, 1);
});

test('search returns packages when relevant', () => {
  const map = fakeMap();
  const result = search(map, 'pg');
  const pkgResult = result.results.find((r) => r.kind === 'package');
  assert.ok(pkgResult, 'should include package result');
  assert.equal(pkgResult.name, 'pg');
});

test('search returns empty on empty query', () => {
  const map = fakeMap();
  assert.equal(search(map, '').results.length, 0);
  assert.equal(search(map, '   ').results.length, 0);
});

/* ------------------------------------------------------------------ */
/* findNode / detail builder                                           */
/* ------------------------------------------------------------------ */

test('buildFileDetail attaches incoming/outgoing/packages', () => {
  const map = fakeMap();
  const detail = buildFileDetail(map, map.files[1]); // db.ts
  assert.equal(detail.connections.incoming.length, 1);
  assert.equal(detail.connections.incoming[0].file_id, 'file_001');
  assert.equal(detail.connections.outgoing.length, 0);
  assert.equal(detail.connections.packages_used.length, 1);
  assert.equal(detail.connections.packages_used[0].name, 'pg');
});

test('findNode resolves files, functions, and packages', () => {
  const map = fakeMap();
  assert.equal(findNode(map, 'file_001').kind, 'file');
  assert.equal(findNode(map, 'fn_002_01').kind, 'function');
  assert.equal(findNode(map, 'pkg_001').kind, 'package');
  assert.equal(findNode(map, 'nope'), null);
});

/* ------------------------------------------------------------------ */
/* Express app — direct invocation                                     */
/* ------------------------------------------------------------------ */

async function withServer(repoPath, fn, opts = {}) {
  const { server, port, url } = await start({ repoPath, outDir: '.reporose', port: 0, silent: true, ...opts });
  try {
    await fn({ server, port, url });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /api/health returns ok', async () => {
  const repo = makeRepo({});
  writeFakeMap(repo);
  try {
    await withServer(repo, async ({ url }) => {
      const res = await getJson(`${url}/api/health`);
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });
  } finally { cleanup(repo); }
});

test('GET /api/graph returns the full map', async () => {
  const repo = makeRepo({});
  const mapPath = writeFakeMap(repo);
  try {
    await withServer(repo, async ({ url }) => {
      const res = await getJson(`${url}/api/graph`);
      assert.equal(res.status, 200);
      assert.equal(res.body.files.length, 3);
      assert.equal(res.body.packages.length, 1);
      assert.equal(res.body.links.length, 2);
      assert.ok(Array.isArray(res.body.networks));
    });
  } finally { cleanup(repo); }
});

test('GET /api/search finds expected results', async () => {
  const repo = makeRepo({});
  writeFakeMap(repo);
  try {
    await withServer(repo, async ({ url }) => {
      const res = await getJson(`${url}/api/search?q=auth`);
      assert.equal(res.status, 200);
      assert.ok(res.body.results.length > 0);
      assert.equal(res.body.results[0].name, 'auth.ts');
    });
  } finally { cleanup(repo); }
});

test('GET /api/node/:id returns file with connections', async () => {
  const repo = makeRepo({});
  writeFakeMap(repo);
  try {
    await withServer(repo, async ({ url }) => {
      const res = await getJson(`${url}/api/node/file_001`);
      assert.equal(res.status, 200);
      assert.equal(res.body.kind, 'file');
      assert.equal(res.body.name, 'auth.ts');
      assert.ok(res.body.connections);
      assert.ok(Array.isArray(res.body.connections.outgoing));
    });
  } finally { cleanup(repo); }
});

test('GET /api/node/:id returns 404 for unknown id', async () => {
  const repo = makeRepo({});
  writeFakeMap(repo);
  try {
    await withServer(repo, async ({ url }) => {
      const res = await getJson(`${url}/api/node/nope`);
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'not_found');
    });
  } finally { cleanup(repo); }
});

test('CORS headers present on /api responses', async () => {
  const repo = makeRepo({});
  writeFakeMap(repo);
  try {
    await withServer(repo, async ({ url }) => {
      const res = await getRaw(`${url}/api/health`);
      assert.equal(res.status, 200);
      assert.equal(res.headers['access-control-allow-origin'], '*');
    });
  } finally { cleanup(repo); }
});

test('GET / serves the index.html frontend', async () => {
  const repo = makeRepo({});
  writeFakeMap(repo);
  try {
    await withServer(repo, async ({ url }) => {
      const res = await getRaw(`${url}/`);
      assert.equal(res.status, 200);
      assert.match(res.body, /<!DOCTYPE html>/i);
      assert.match(res.body, /RepoRose/);
    });
  } finally { cleanup(repo); }
});

test('GET /styles.css and /app.js are served', async () => {
  const repo = makeRepo({});
  writeFakeMap(repo);
  try {
    await withServer(repo, async ({ url }) => {
      const css = await getRaw(`${url}/styles.css`);
      assert.equal(css.status, 200);
      assert.match(css.headers['content-type'] || '', /text\/css/);

      const js = await getRaw(`${url}/app.js`);
      assert.equal(js.status, 200);
      assert.match(js.headers['content-type'] || '', /javascript/);
    });
  } finally { cleanup(repo); }
});

test('unknown /api path returns 404 JSON', async () => {
  const repo = makeRepo({});
  writeFakeMap(repo);
  try {
    await withServer(repo, async ({ url }) => {
      const res = await getJson(`${url}/api/does-not-exist`);
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'not_found');
    });
  } finally { cleanup(repo); }
});

test('missing map yields a clear error response', async () => {
  // Create app pointing at a non-existent map
  const app = createApp({
    repoPath: '/tmp/definitely-does-not-exist',
    outDir: '.reporose',
    silent: true,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const res = await getJson(`http://127.0.0.1:${port}/api/graph`);
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'ENOENT');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ------------------------------------------------------------------ */
/* Port handling                                                        */
/* ------------------------------------------------------------------ */

test('listenWithFallback finds a free port when the requested one is taken', async () => {
  // Occupy a port first.
  const blocker = http.createServer(() => {});
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const taken = blocker.address().port;

  const newServer = http.createServer(() => {});
  try {
    const finalPort = await listenWithFallback(newServer, taken, '127.0.0.1', 5);
    assert.notEqual(finalPort, taken);
    assert.ok(finalPort > taken);
    await new Promise((resolve) => newServer.close(resolve));
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

/* ------------------------------------------------------------------ */
/* dotenv                                                               */
/* ------------------------------------------------------------------ */

test('loadDotenv parses KEY=VALUE pairs without overwriting existing env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-env-'));
  try {
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, [
      '# a comment',
      'FOO=bar',
      'export BAZ="hello world"',
      "QUOTED='single'",
      'WITH_HASH=value # inline',
      '',
    ].join('\n'));

    delete process.env.FOO; delete process.env.BAZ; delete process.env.QUOTED; delete process.env.WITH_HASH;
    process.env.PRESET = 'preserved';

    const env = loadDotenv(envFile);
    assert.equal(env.FOO, 'bar');
    assert.equal(env.BAZ, 'hello world');
    assert.equal(env.QUOTED, 'single');
    assert.equal(env.WITH_HASH, 'value');
    assert.equal(process.env.FOO, 'bar');
    assert.equal(process.env.BAZ, 'hello world');

    // Pre-existing env wins.
    process.env.OVERRIDE_ME = 'kept';
    fs.writeFileSync(envFile, 'OVERRIDE_ME=changed\n');
    loadDotenv(envFile);
    assert.equal(process.env.OVERRIDE_ME, 'kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.FOO; delete process.env.BAZ; delete process.env.QUOTED;
    delete process.env.WITH_HASH; delete process.env.PRESET; delete process.env.OVERRIDE_ME;
  }
});
