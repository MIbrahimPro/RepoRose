'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { scan, md5Buffer, parseSource, extractFromAst } = require('../src/core/scanner');
const { analyze } = require('../src/cli/commands');
const { loadIgnore } = require('../src/utils/ignore');

/* ------------------------------------------------------------------ */
/* Tiny temp-fixture helper                                            */
/* ------------------------------------------------------------------ */

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-test-'));
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
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test('parses a React component file (functions, imports, default export)', async () => {
  const repo = makeRepo({
    'src/App.jsx': `
import React, { useState } from 'react';
import { Button } from './components/Button';

export const Title = ({ text }) => <h1>{text}</h1>;

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <Title text="hello" />
      <Button onClick={() => setCount(count + 1)}>Click {count}</Button>
    </div>
  );
}
`.trimStart(),
  });
  try {
    const map = await scan(repo);
    const file = findFile(map, 'src/App.jsx');
    assert.ok(file, 'App.jsx should be present');
    assert.equal(file.type, 'code');
    assert.equal(file.language, 'javascriptreact');

    const importSources = file.imports.map((i) => i.source);
    assert.ok(importSources.includes('react'));
    assert.ok(importSources.includes('./components/Button'));
    const reactImport = file.imports.find((i) => i.source === 'react');
    assert.equal(reactImport.type, 'package');
    assert.equal(typeof reactImport.line_imported, 'number');
    const localImport = file.imports.find((i) => i.source === './components/Button');
    assert.equal(localImport.type, 'file');

    const fnNames = file.functions.map((f) => f.name);
    assert.ok(fnNames.includes('Title'), 'arrow component Title should be extracted');
    assert.ok(fnNames.includes('App'), 'default function App should be extracted');

    const exportedNames = file.exported.map((e) => e.name);
    assert.ok(exportedNames.includes('Title'));
    assert.ok(exportedNames.includes('default') || exportedNames.includes('App'));
  } finally {
    cleanup(repo);
  }
});

test('parses an Express middleware file (CommonJS require + module.exports)', async () => {
  const repo = makeRepo({
    'middleware/auth.js': `
const jwt = require('jsonwebtoken');
const { findUser } = require('../db/users');

function authenticate(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).send('no token');
  try {
    const decoded = jwt.verify(token, process.env.SECRET);
    req.user = findUser(decoded.id);
    next();
  } catch (e) {
    res.status(401).send('bad token');
  }
}

module.exports = authenticate;
`.trimStart(),
  });
  try {
    const map = await scan(repo);
    const file = findFile(map, 'middleware/auth.js');
    assert.ok(file);
    assert.equal(file.language, 'javascript');

    const importSources = file.imports.map((i) => i.source);
    assert.ok(importSources.includes('jsonwebtoken'), 'should detect jwt require');
    assert.ok(importSources.includes('../db/users'), 'should detect relative require');

    const fn = file.functions.find((f) => f.name === 'authenticate');
    assert.ok(fn, 'authenticate function should be extracted');
    assert.equal(fn.type, 'function');
    assert.deepEqual(fn.parameters, ['req', 'res', 'next']);
    assert.ok(fn.line_start > 0);
    assert.ok(fn.line_end >= fn.line_start);

    // module.exports = authenticate -> should produce some export entry
    assert.ok(file.exported.length > 0, 'should record at least one export');
  } finally {
    cleanup(repo);
  }
});

test('parses a Next.js API route (default export async function)', async () => {
  const repo = makeRepo({
    'pages/api/hello.ts': `
import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  res.status(200).json({ name: 'hello' });
}
`.trimStart(),
  });
  try {
    const map = await scan(repo);
    const file = findFile(map, 'pages/api/hello.ts');
    assert.ok(file);
    assert.equal(file.language, 'typescript');

    const handler = file.functions.find((f) => f.name === 'handler');
    assert.ok(handler, 'handler should be extracted');
    assert.equal(handler.type, 'function');
    assert.equal(handler.exports, true);
    assert.equal(handler.return_type, 'Promise<void>');
    assert.ok(handler.parameters.some((p) => p.includes('NextApiRequest')));
    assert.ok(handler.parameters.some((p) => p.includes('NextApiResponse')));
    assert.ok(handler.signature.includes('async'));

    const exportedNames = file.exported.map((e) => e.name);
    assert.ok(exportedNames.includes('default'));
  } finally {
    cleanup(repo);
  }
});

test('parses TypeScript with interfaces, types, classes', async () => {
  const repo = makeRepo({
    'src/models.ts': `
export interface User {
  id: string;
  name: string;
}

export type Role = 'admin' | 'guest';

export class UserService {
  constructor(private readonly db: any) {}

  async findById(id: string): Promise<User | null> {
    return this.db.lookup(id);
  }
}

const VERSION: string = '1.0.0';
export { VERSION };
`.trimStart(),
  });
  try {
    const map = await scan(repo);
    const file = findFile(map, 'src/models.ts');
    assert.ok(file);

    const byName = Object.fromEntries(file.functions.map((f) => [f.name, f]));
    assert.ok(byName.User, 'interface User');
    assert.equal(byName.User.type, 'interface');
    assert.ok(byName.Role, 'type Role');
    assert.equal(byName.Role.type, 'type');
    assert.ok(byName.UserService, 'class UserService');
    assert.equal(byName.UserService.type, 'class');
    assert.ok(byName.VERSION, 'constant VERSION');
    assert.equal(byName.VERSION.type, 'constant');

    const exportedNames = file.exported.map((e) => e.name);
    for (const name of ['User', 'Role', 'UserService', 'VERSION']) {
      assert.ok(exportedNames.includes(name), `should export ${name}`);
    }
  } finally {
    cleanup(repo);
  }
});

test('respects .gitignore patterns (file + directory + nested)', async () => {
  const repo = makeRepo({
    '.gitignore': 'dist/\nsecret.txt\n*.log\n',
    'src/index.js': 'export const a = 1;\n',
    'dist/bundle.js': 'console.log("nope");\n',
    'secret.txt': 'top-secret',
    'app.log': 'noise',
    'docs/readme.md': '# docs',
    'docs/.gitignore': 'private/\n',
    'docs/private/notes.md': 'hidden',
    'docs/public/notes.md': 'visible',
  });
  try {
    const map = await scan(repo, { includeDocs: true, aggressive: false });
    const paths = map.files.map((f) => f.path);

    assert.ok(paths.includes('src/index.js'));
    assert.ok(paths.includes('docs/readme.md'));
    assert.ok(paths.includes('docs/public/notes.md'));

    assert.ok(!paths.includes('dist/bundle.js'), 'dist/ should be ignored');
    assert.ok(!paths.includes('secret.txt'), 'secret.txt should be ignored');
    assert.ok(!paths.includes('app.log'), '*.log should be ignored');
    assert.ok(
      !paths.includes('docs/private/notes.md'),
      'nested .gitignore should hide docs/private/',
    );

    assert.ok(map.metadata.files_ignored > 0, 'files_ignored should be tracked');
  } finally {
    cleanup(repo);
  }
});

test('skips node_modules but tracks declared packages', async () => {
  const repo = makeRepo({
    'package.json': JSON.stringify({
      name: 'demo',
      version: '0.0.1',
      dependencies: { react: '^18.0.0' },
      devDependencies: { jest: '^29.0.0' },
    }),
    'node_modules/react/package.json': JSON.stringify({ name: 'react', version: '18.2.0' }),
    'node_modules/react/index.js': 'module.exports = "react";',
    'src/index.js': 'export const x = 1;\n',
  });
  try {
    const map = await scan(repo);
    const paths = map.files.map((f) => f.path);
    assert.ok(!paths.some((p) => p.startsWith('node_modules/')), 'node_modules should be skipped');
    assert.ok(paths.includes('src/index.js'));

    const names = map.packages.map((p) => p.name);
    assert.ok(names.includes('react'));
    assert.ok(names.includes('jest'));

    const react = map.packages.find((p) => p.name === 'react');
    assert.equal(react.version, '18.2.0', 'should pick installed version when available');
    assert.equal(react.location, 'node_modules/react');
    assert.equal(react.type, 'external_package');

    const jest = map.packages.find((p) => p.name === 'jest');
    assert.equal(jest.version, '^29.0.0', 'falls back to declared version when not installed');
  } finally {
    cleanup(repo);
  }
});

test('produces valid JSON output via the analyze CLI command', async () => {
  const repo = makeRepo({
    'package.json': JSON.stringify({ name: 'demo', version: '0.0.1' }),
    'src/a.ts': 'export const a: number = 1;\n',
    'src/b.ts': "import { a } from './a';\nexport const b = a + 1;\n",
    'README.md': '# demo\n',
  });
  try {
    const { outputPath, map } = await analyze(repo, { silent: true });
    assert.ok(fs.existsSync(outputPath), 'index.json should be created');
    assert.equal(outputPath, path.join(repo, '.reporose', 'index.json'));

    const raw = fs.readFileSync(outputPath, 'utf8');
    const parsed = JSON.parse(raw); // throws on invalid JSON
    assert.equal(parsed.metadata.format_version, '2.0');
    assert.equal(parsed.metadata.files_analyzed, map.metadata.files_analyzed);
    assert.ok(Array.isArray(parsed.files));
    assert.ok(Array.isArray(parsed.packages));
    assert.ok(Array.isArray(parsed.networks));
    assert.ok(Array.isArray(parsed.links));
    assert.ok(Array.isArray(parsed.circular_dependencies));
    assert.equal(typeof parsed.statistics, 'object');
  } finally {
    cleanup(repo);
  }
});

test('calculates MD5 file hashes that match crypto output', async () => {
  const content = 'export const hello = "world";\n';
  const repo = makeRepo({ 'a.js': content });
  try {
    const map = await scan(repo);
    const file = findFile(map, 'a.js');
    assert.ok(file);
    const expected = crypto.createHash('md5').update(content).digest('hex');
    assert.equal(file.hash, expected);
    assert.equal(file.hash.length, 32);
    assert.equal(md5Buffer(Buffer.from(content)), expected);
  } finally {
    cleanup(repo);
  }
});

test('classifies different file types correctly', async () => {
  const repo = makeRepo({
    'a.ts': 'export const a = 1;\n',
    'b.css': '.x { color: red; }\n',
    'c.md': '# hi\n',
    'd.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'e.sql': 'SELECT 1;\n',
    'f.json': '{}',
    '.env.example': 'KEY=value\n',
    'random.bin': 'binary',
  });
  try {
    const map = await scan(repo, { includeDocs: true, includeMedia: true, aggressive: false });
    const byPath = Object.fromEntries(map.files.map((f) => [f.path, f]));
    assert.equal(byPath['a.ts'].type, 'code');
    assert.equal(byPath['b.css'].type, 'style');
    assert.equal(byPath['c.md'].type, 'docs');
    assert.equal(byPath['d.png'].type, 'media');
    assert.equal(byPath['e.sql'].type, 'database');
    assert.equal(byPath['f.json'].type, 'config');
    assert.equal(byPath['.env.example'].type, 'config');
    assert.equal(byPath['random.bin'].type, 'other');
  } finally {
    cleanup(repo);
  }
});

test('handles malformed code gracefully (no crash, file still listed)', async () => {
  const repo = makeRepo({
    'broken.js': 'function (((((( {\n',
    'good.js': 'export const ok = 1;\n',
  });
  try {
    const map = await scan(repo);
    const broken = findFile(map, 'broken.js');
    const good = findFile(map, 'good.js');
    assert.ok(broken, 'broken file should still be listed');
    assert.ok(good, 'good file should still be listed');
    // good file should still produce a function entry
    assert.ok(good.functions.some((f) => f.name === 'ok'));
  } finally {
    cleanup(repo);
  }
});

test('loadIgnore always ignores .git and node_modules', () => {
  const repo = makeRepo({ 'a.txt': 'hi' });
  try {
    const ig = loadIgnore(repo);
    assert.ok(ig.ignores('node_modules/'));
    assert.ok(ig.ignores('node_modules/foo/index.js'));
    assert.ok(ig.ignores('.git/'));
    assert.ok(ig.ignores('.git/HEAD'));
    assert.ok(!ig.ignores('a.txt'));
  } finally {
    cleanup(repo);
  }
});

test('extractFromAst pulls correct line numbers for imports', () => {
  const src =
    "// header\n" +
    "import a from 'a';\n" +
    "\n" +
    "import b from './b';\n" +
    "export const x = 1;\n";
  const ast = parseSource(src, 'x.ts');
  const out = extractFromAst(ast, src, 'file_001');
  const aImp = out.imports.find((i) => i.source === 'a');
  const bImp = out.imports.find((i) => i.source === './b');
  assert.equal(aImp.line_imported, 2);
  assert.equal(bImp.line_imported, 4);
  assert.equal(aImp.type, 'package');
  assert.equal(bImp.type, 'file');
});
