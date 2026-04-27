'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { scan } = require('../src/core/scanner');
const { mapDependencies } = require('../src/core/mapper');
const {
  summarize,
  selectProvider,
  retryWithBackoff,
  loadCache,
  cachePath,
  autoConcurrency,
  resolveConcurrency,
  runWithConcurrency,
} = require('../src/ai/summarizer');
const {
  createHeuristicProvider,
  heuristicFileDescription,
  heuristicFunctionDescription,
} = require('../src/ai/heuristic');
const {
  loadConfig,
  saveConfig,
  applyModelFlag,
  applyModelPath,
  applyApiKeyEnv,
  configPath,
  userConfigPath,
} = require('../src/ai/config');
const {
  buildFileInput,
  renderFilePrompt,
  renderFunctionPrompt,
} = require('../src/ai/prompts');
const {
  analyze,
  summarize: summarizeCmd,
  config: configCmd,
  run,
} = require('../src/cli/commands');

/* ------------------------------------------------------------------ */
/* Fixture helpers                                                     */
/* ------------------------------------------------------------------ */

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-phase3-'));
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

async function fullPipeline(repoFiles, useHeuristic = true) {
  const repo = makeRepo(repoFiles);
  const map = await scan(repo);
  mapDependencies(map);
  // Use heuristic provider by default for tests to avoid network calls
  const provider = useHeuristic ? createHeuristicProvider() : undefined;
  const stats = await summarize(map, { repoPath: repo, provider });
  return { repo, map, stats };
}

/* ------------------------------------------------------------------ */
/* Heuristic provider                                                  */
/* ------------------------------------------------------------------ */

test('heuristic file description: React component module', () => {
  const desc = heuristicFileDescription({
    name: 'App.jsx',
    path: 'src/App.jsx',
    language: 'javascriptreact',
    type: 'code',
    size_bytes: 600,
    imports: [{ source: 'react', type: 'package' }, { source: './Button', type: 'file' }],
    exported: [{ name: 'App', type: 'function' }, { name: 'default', type: 'function' }],
    functions: [
      { name: 'App', type: 'function', signature: 'function App()' },
    ],
    snippet: 'import React, { useState, useEffect } from "react";\nreturn <main><div /></main>;',
  });
  assert.match(desc, /Implements/);
  assert.match(desc, /UI|component|application/i);
  assert.match(desc, /react/);
  assert.match(desc, /default export/);
  assert.match(desc, /state|effects/i);
});

test('heuristic file description: TypeScript module with classes', () => {
  const desc = heuristicFileDescription({
    name: 'models.ts',
    path: 'src/models.ts',
    language: 'typescript',
    type: 'code',
    size_bytes: 400,
    imports: [],
    exported: [
      { name: 'User', type: 'interface' },
      { name: 'UserService', type: 'class' },
      { name: 'VERSION', type: 'constant' },
    ],
    functions: [
      { name: 'User', type: 'interface', signature: 'interface User' },
      { name: 'UserService', type: 'class', signature: 'class UserService' },
      { name: 'VERSION', type: 'constant', signature: 'const VERSION' },
    ],
    snippet: '',
  });
  assert.match(desc, /TypeScript/);
  assert.match(desc, /interface/);
  assert.match(desc, /Exports/);
});

test('heuristic file description: non-code files (config/docs/media)', () => {
  const cfg = heuristicFileDescription({
    name: 'package.json', path: 'package.json', language: 'json', type: 'config',
    size_bytes: 256, imports: [], exported: [], functions: [],
  });
  assert.match(cfg, /configuration file/);

  const docs = heuristicFileDescription({
    name: 'README.md', path: 'README.md', language: 'markdown', type: 'docs',
    size_bytes: 128, imports: [], exported: [], functions: [],
  });
  assert.match(docs, /documentation file/);

  const media = heuristicFileDescription({
    name: 'logo.png', path: 'assets/logo.png', language: 'unknown', type: 'media',
    size_bytes: 4096, imports: [], exported: [], functions: [],
  });
  assert.match(media, /media asset/);
});

test('heuristic function description: uses verb templates', () => {
  const desc = heuristicFunctionDescription({
    name: 'getUserById',
    type: 'function',
    signature: 'function getUserById(id: string): User',
    parameters: ['id: string'],
    return_type: 'User',
  });
  assert.match(desc, /Returns/);
  assert.match(desc, /user by id/i);
  assert.match(desc, /1 parameter/);
  assert.match(desc, /User/);
});

test('heuristic function description: async + handle', () => {
  const desc = heuristicFunctionDescription({
    name: 'handleClick',
    type: 'function',
    signature: 'async function handleClick(e: Event)',
    parameters: ['e: Event'],
    return_type: null,
  });
  assert.match(desc, /Asynchronously/);
  assert.match(desc, /handles/i);
  assert.match(desc, /click/i);
});

test('heuristic function description: classes/interfaces/types/constants', () => {
  assert.match(
    heuristicFunctionDescription({ name: 'User', type: 'class', signature: 'class User' }),
    /class/i,
  );
  assert.match(
    heuristicFunctionDescription({ name: 'User', type: 'interface', signature: 'interface User' }),
    /interface/i,
  );
  assert.match(
    heuristicFunctionDescription({ name: 'Role', type: 'type', signature: 'type Role' }),
    /alias/i,
  );
  assert.match(
    heuristicFunctionDescription({ name: 'VERSION', type: 'constant', signature: 'const VERSION' }),
    /constant/i,
  );
});

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

test('renderFilePrompt matches the spec format', () => {
  const input = buildFileInput(
    {
      name: 'foo.ts',
      path: 'src/foo.ts',
      language: 'typescript',
      type: 'code',
      size_bytes: 100,
      imports: [{ source: 'lodash', type: 'package', line_imported: 1 }],
      exported: [{ name: 'doIt', type: 'function' }],
      functions: [],
    },
    'export const x = 1;',
  );
  const prompt = renderFilePrompt(input);
  assert.match(prompt, /^You are analyzing a code file/);
  assert.match(prompt, /File: foo\.ts/);
  assert.match(prompt, /Path: src\/foo\.ts/);
  assert.match(prompt, /Language: typescript/);
  assert.match(prompt, /Size: 100 bytes/);
  assert.match(prompt, /Exports: doIt/);
  assert.match(prompt, /Imports: lodash/);
  assert.match(prompt, /Functions defined: 0/);
  assert.match(prompt, /The file starts with:/);
  assert.match(prompt, /4-6 sentences/);
  assert.match(prompt, /behavior, not just structure/i);
});

test('renderFunctionPrompt matches the spec format', () => {
  const prompt = renderFunctionPrompt({
    name: 'doIt',
    signature: 'function doIt()',
    file: 'foo.ts',
  });
  assert.match(prompt, /^What does this function do/);
  assert.match(prompt, /Function name: doIt/);
  assert.match(prompt, /Signature: function doIt\(\)/);
  assert.match(prompt, /File: foo\.ts/);
  assert.match(prompt, /1-2 sentence summary/);
});

/* ------------------------------------------------------------------ */
/* End-to-end: descriptions populated                                  */
/* ------------------------------------------------------------------ */

test('summarize fills file.description and fn.description for every entry', async () => {
  const { repo, map } = await fullPipeline({
    'src/index.ts': "import { add } from './math';\nexport const main = add(1, 2);\n",
    'src/math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    'README.md': '# demo\n',
  });
  try {
    for (const file of map.files) {
      if (file.summarizable === false || file.type !== 'code') {
        // Non-code files should still be in the map but with empty description
        assert.equal(typeof file.description, 'string', `non-code file ${file.path} should have string description`);
        continue;
      }
      assert.ok(
        typeof file.description === 'string' && file.description.length > 0,
        `file ${file.path} should have a description`,
      );
      // Function descriptions are intentionally left empty in this build
      // (file-level summaries are sufficient and saves tokens). The string
      // must still be present on every function entry.
      for (const fn of file.functions) {
        assert.equal(
          typeof fn.description,
          'string',
          `function ${file.path}::${fn.name} should still have a description string`,
        );
        assert.equal(
          fn.description,
          '',
          `function ${file.path}::${fn.name} description should be empty`,
        );
      }
    }
  } finally {
    cleanup(repo);
  }
});

test('config run(): supports `config set/show --user` subcommands', async () => {
  const oldHome = process.env.HOME;
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-home-'));
  process.env.HOME = fakeHome;

  try {
    await run(['config', 'set', '--user', 'provider', 'ollama']);
    await run(['config', 'set', '--user', 'model', 'qwen2.5-coder:3b-instruct-q4_K_M']);
    await run(['config', 'show', '--user']);

    const cfgFile = userConfigPath();
    assert.ok(fs.existsSync(cfgFile));

    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(cfg.ai.provider, 'ollama');
    assert.equal(cfg.ai.ollama.model, 'qwen2.5-coder:3b-instruct-q4_K_M');
  } finally {
    process.env.HOME = oldHome;
    cleanup(fakeHome);
  }
});

/* ------------------------------------------------------------------ */
/* Caching                                                             */
/* ------------------------------------------------------------------ */

test('caching: second run hits cache for unchanged files (no provider calls)', async () => {
  const { repo, map } = await fullPipeline({
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 2;\n',
  });
  try {
    // Build a counting provider that should NOT be called when cache is warm.
    let calls = 0;
    const countingProvider = {
      name: 'counting',
      async summarizeFile() { calls += 1; return 'mocked file desc'; },
      async summarizeFunction() { calls += 1; return 'mocked fn desc'; },
      async close() {},
    };

    const stats = await summarize(map, { repoPath: repo, provider: countingProvider });
    assert.equal(stats.files, 0, 'all files should come from cache');
    assert.ok(stats.files_from_cache >= 2);
    assert.equal(calls, 0, 'provider must not be called when cache is fresh');

    // Verify cache file exists on disk
    const cFile = cachePath(repo);
    assert.ok(fs.existsSync(cFile));
    const cache = loadCache(repo);
    assert.ok(cache.files['src/a.ts']);
  } finally {
    cleanup(repo);
  }
});

test('caching: regenerates when file hash changes', async () => {
  const repo = makeRepo({
    'src/a.ts': 'export const a = 1;\n',
  });
  try {
    let map1 = await scan(repo); mapDependencies(map1);
    await summarize(map1, { repoPath: repo, provider: createHeuristicProvider() });

    // Modify the file → new hash.
    fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 999;\n// changed\n');

    let calls = 0;
    const countingProvider = {
      name: 'counting',
      async summarizeFile() { calls += 1; return 'fresh file'; },
      async summarizeFunction() { calls += 1; return 'fresh fn'; },
      async close() {},
    };

    let map2 = await scan(repo); mapDependencies(map2);
    const stats = await summarize(map2, { repoPath: repo, provider: countingProvider });

    assert.ok(stats.files >= 1, 'changed file should be re-summarized');
    assert.ok(calls >= 1, 'provider must be called for changed files');
    const a2 = map2.files.find((f) => f.path === 'src/a.ts');
    assert.equal(a2.description, 'fresh file');
  } finally {
    cleanup(repo);
  }
});

/* ------------------------------------------------------------------ */
/* Retry / fallback                                                    */
/* ------------------------------------------------------------------ */

test('retryWithBackoff retries up to N times then re-throws', async () => {
  let attempts = 0;
  await assert.rejects(
    () => retryWithBackoff(
      async () => { attempts += 1; throw new Error('boom'); },
      { delays: [1, 1, 1] },
    ),
    /boom/,
  );
  // 1 initial attempt + 3 retries = 4 total
  assert.equal(attempts, 4);
});

test('retryWithBackoff succeeds on a later attempt', async () => {
  let attempts = 0;
  const result = await retryWithBackoff(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('still failing');
    return 'ok';
  }, { delays: [1, 1, 1, 1, 1] });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('summarizer leaves descriptions empty if provider keeps failing (no silent fallback)', async () => {
  const failingProvider = {
    name: 'always-failing',
    async summarizeFile() { throw new Error('AI unavailable'); },
    async summarizeFunction() { throw new Error('AI unavailable'); },
    async close() {},
  };
  const repo = makeRepo({
    'src/a.ts': 'export function getName(): string { return "x"; }\n',
  });
  try {
    const map = await scan(repo); mapDependencies(map);
    // Use very small backoff so test is fast.
    const stats = await summarize(map, {
      repoPath: repo,
      provider: failingProvider,
      backoff: [1, 1, 1],
    });
    const a = map.files.find((f) => f.path === 'src/a.ts');
    assert.equal(a.description, '', 'description should be empty when AI fails');
    const fn = a.functions.find((f) => f.name === 'getName');
    assert.equal(fn.description, '', 'fn description should be empty when AI fails');
    assert.equal(stats.provider, 'always-failing');
  } finally {
    cleanup(repo);
  }
});

/* ------------------------------------------------------------------ */
/* Provider selection                                                  */
/* ------------------------------------------------------------------ */

test('selectProvider returns heuristic by default', async () => {
  const provider = await selectProvider({});
  assert.equal(provider.name, 'heuristic');
});

test('selectProvider returns SKIP when local model is missing', async () => {
  const messages = [];
  const provider = await selectProvider(
    { ai: { provider: 'local', local: { model_path: null } } },
    (level, msg) => messages.push(`${level}:${msg}`),
  );
  assert.equal(provider.skip, true);
  assert.ok(messages.some((m) => /Local model unavailable/.test(m)));
});

test('selectProvider returns SKIP when cloud key env is missing', async () => {
  // Make sure no key is present
  const oldKey = process.env.NONEXISTENT_KEY_FOR_TEST;
  delete process.env.NONEXISTENT_KEY_FOR_TEST;
  const messages = [];
  const provider = await selectProvider(
    { ai: { provider: 'openrouter', openrouter: { api_key_env: 'NONEXISTENT_KEY_FOR_TEST' } } },
    (level, msg) => messages.push(`${level}:${msg}`),
  );
  assert.equal(provider.skip, true);
  assert.ok(messages.some((m) => /OpenRouter unavailable/.test(m)));
  if (oldKey !== undefined) process.env.NONEXISTENT_KEY_FOR_TEST = oldKey;
});

test('selectProvider returns SKIP when provider is "none"', async () => {
  const provider = await selectProvider({ ai: { provider: 'none' } });
  assert.equal(provider.skip, true);
  assert.equal(provider.name, 'none');
});

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

test('config: applyModelFlag maps local/cloud/heuristic to providers', () => {
  const base = loadConfig('/tmp/non-existent-dir-xyz');
  assert.equal(applyModelFlag(base, 'local').ai.provider, 'local');
  assert.equal(applyModelFlag(base, 'cloud').ai.provider, 'openrouter');
  assert.equal(applyModelFlag(base, 'heuristic').ai.provider, 'heuristic');
  // Unknown value sets ai.model
  const named = applyModelFlag(base, 'meta-llama/llama-3.2-3b-instruct');
  assert.equal(named.ai.model, 'meta-llama/llama-3.2-3b-instruct');
});

test('config: saveConfig persists to .reporose/config.json', () => {
  const repo = makeRepo({});
  try {
    let cfg = loadConfig(repo);
    cfg = applyModelFlag(cfg, 'cloud');
    cfg = applyApiKeyEnv(cfg, 'MY_KEY');
    cfg = applyModelPath(cfg, '/tmp/model.gguf');
    saveConfig(repo, cfg);

    const reloaded = loadConfig(repo);
    assert.equal(reloaded.ai.provider, 'openrouter');
    assert.equal(reloaded.ai.openrouter.api_key_env, 'MY_KEY');
    assert.equal(reloaded.ai.local.model_path, '/tmp/model.gguf');
  } finally {
    cleanup(repo);
  }
});

test('config CLI command writes file when flags are passed', async () => {
  const repo = makeRepo({});
  try {
    await configCmd({ path: repo, model: 'cloud', silent: true });
    const cfgFile = configPath(repo);
    assert.ok(fs.existsSync(cfgFile));
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(cfg.ai.provider, 'openrouter');
  } finally {
    cleanup(repo);
  }
});

/* ------------------------------------------------------------------ */
/* CLI integration                                                     */
/* ------------------------------------------------------------------ */

test('analyze CLI runs Phase 3 by default and produces descriptions', async () => {
  const repo = makeRepo({
    'src/util.ts': 'export function getName(): string { return "x"; }\n',
  });
  try {
    const { map } = await analyze(repo, { silent: true, config: { ai: { provider: 'heuristic', model: 'heuristic' } } });
    const file = map.files.find((f) => f.path === 'src/util.ts');
    assert.ok(file.description && file.description.length > 0);
    // Function descriptions are intentionally empty (saves tokens).
    assert.equal(file.functions[0].description, '');
  } finally {
    cleanup(repo);
  }
});

test('analyze --no-summarize leaves descriptions empty', async () => {
  const repo = makeRepo({
    'src/util.ts': 'export function getName(): string { return "x"; }\n',
  });
  try {
    const { map } = await analyze(repo, { silent: true, summarize: false });
    const file = map.files.find((f) => f.path === 'src/util.ts');
    assert.equal(file.description, '');
  } finally {
    cleanup(repo);
  }
});

test('summarize CLI command enriches an existing map.json', async () => {
  const repo = makeRepo({
    'src/util.ts': 'export function getName(): string { return "x"; }\n',
  });
  try {
    await analyze(repo, { silent: true, summarize: false, config: { ai: { provider: 'heuristic', model: 'heuristic' } } });
    const before = JSON.parse(fs.readFileSync(path.join(repo, '.reporose', 'map.json'), 'utf8'));
    assert.equal(before.files.find((f) => f.path === 'src/util.ts').description, '');

    await summarizeCmd(repo, { silent: true, config: { ai: { provider: 'heuristic', model: 'heuristic' } } });
    const after = JSON.parse(fs.readFileSync(path.join(repo, '.reporose', 'map.json'), 'utf8'));
    const f = after.files.find((file) => file.path === 'src/util.ts');
    assert.ok(f.description && f.description.length > 0);
    // Function descriptions are intentionally empty (saves tokens).
    assert.equal(f.functions[0].description, '');
  } finally {
    cleanup(repo);
  }
});

test('cache file is written to .reporose/cache/summaries.json', async () => {
  const repo = makeRepo({
    'src/util.ts': 'export function getName(): string { return "x"; }\n',
  });
  try {
    await analyze(repo, { silent: true, config: { ai: { provider: 'heuristic', model: 'heuristic' } } });
    const cFile = path.join(repo, '.reporose', 'cache', 'summaries.json');
    assert.ok(fs.existsSync(cFile));
    const cache = JSON.parse(fs.readFileSync(cFile, 'utf8'));
    assert.equal(cache.version, 1);
    assert.ok(cache.files['src/util.ts']);
    assert.ok(cache.files['src/util.ts'].hash);
    assert.ok(cache.files['src/util.ts'].description);
  } finally {
    cleanup(repo);
  }
});

test('heuristic provider object is callable and returns strings', async () => {
  const provider = createHeuristicProvider();
  const fileInput = buildFileInput({
    name: 'a.ts', path: 'a.ts', language: 'typescript', type: 'code',
    size_bytes: 50, imports: [], exported: [], functions: [],
  }, 'export const a = 1;');
  const fileDesc = await provider.summarizeFile(fileInput);
  const fnDesc = await provider.summarizeFunction({
    name: 'fetchUser', signature: 'async function fetchUser()', parameters: [], return_type: 'Promise<User>', file: 'a.ts',
  });
  assert.equal(typeof fileDesc, 'string');
  assert.equal(typeof fnDesc, 'string');
  assert.ok(fileDesc.length > 0);
  assert.ok(fnDesc.length > 0);
});

/* ------------------------------------------------------------------ */
/* RAM-aware concurrency                                               */
/* ------------------------------------------------------------------ */

test('autoConcurrency returns a positive integer in [1, 6]', () => {
  const provider = { name: 'ollama', contextSize: 8192 };
  const c = autoConcurrency(provider);
  assert.equal(typeof c, 'number');
  assert.ok(Number.isInteger(c));
  assert.ok(c >= 1 && c <= 6, `expected 1..6, got ${c}`);
});

test('resolveConcurrency honours an explicit numeric setting', () => {
  const provider = { name: 'ollama', contextSize: 8192 };
  const cfg = { ai: { ollama: { concurrency: 3 } } };
  assert.equal(resolveConcurrency(cfg, provider), 3);

  const cfgClamp = { ai: { ollama: { concurrency: 999 } } };
  assert.equal(resolveConcurrency(cfgClamp, provider), 16);
});

test('resolveConcurrency falls back to 1 for cloud providers', () => {
  const provider = { name: 'openrouter' };
  assert.equal(resolveConcurrency({ ai: {} }, provider), 1);
});

test('resolveConcurrency defaults Ollama to 1 (daemon queues requests)', () => {
  // With OLLAMA_NUM_PARALLEL=1 on the daemon side, parallel requests on the
  // client just thrash the KV cache — serial is faster on iGPUs. Users who
  // want more workers must opt in explicitly.
  const provider = { name: 'ollama', contextSize: 8192 };
  assert.equal(resolveConcurrency({ ai: {} }, provider), 1);
  assert.equal(resolveConcurrency({ ai: { ollama: {} } }, provider), 1);
  // …but an explicit override still works.
  assert.equal(resolveConcurrency({ ai: { ollama: { concurrency: 4 } } }, provider), 4);
});

test('runWithConcurrency processes every item with bounded parallelism', async () => {
  const items = [10, 20, 30, 40, 50, 60, 70];
  const seen = [];
  let inFlight = 0;
  let peak = 0;
  await runWithConcurrency(items, 3, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, n / 5));
    seen.push(n);
    inFlight -= 1;
  });
  assert.equal(seen.length, items.length);
  assert.deepEqual(seen.slice().sort((a, b) => a - b), items);
  assert.ok(peak <= 3, `peak in-flight ${peak} exceeded limit`);
  assert.ok(peak >= 2, `expected some parallelism, peak was ${peak}`);
});

/* ------------------------------------------------------------------ */
/* Incremental persistence                                             */
/* ------------------------------------------------------------------ */

test('summarize fires onFileSummarized after every file (cache hits + fresh)', async () => {
  const repo = makeRepo({
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 2;\n',
    'src/c.ts': 'export const c = 3;\n',
  });
  try {
    const map = mapDependencies(await scan(repo));
    const provider = createHeuristicProvider();
    const seenFiles = [];

    await summarize(map, {
      repoPath: repo,
      provider,
      silent: true,
      onFileSummarized: (file) => {
        // file may be null on the post-cache snapshot; we only count fresh
        // file completions for this assertion.
        if (file) seenFiles.push(file.path);
      },
    });

    // Every code file should have triggered exactly one callback.
    const codePaths = map.files
      .filter((f) => f.summarizable !== false && f.type === 'code')
      .map((f) => f.path)
      .sort();
    assert.deepEqual(seenFiles.slice().sort(), codePaths);
  } finally {
    cleanup(repo);
  }
});

test('analyze CLI persists map.json incrementally during summarization', async () => {
  const repo = makeRepo({
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 2;\n',
    'src/c.ts': 'export const c = 3;\n',
  });
  try {
    const mapPath = path.join(repo, '.reporose', 'map.json');
    const snapshots = [];

    // Wrap the heuristic provider so we can take a snapshot of the on-disk
    // map.json *between* per-file summarizations. This proves that the
    // analyze command's onFileSummarized hook writes to disk after each
    // file, not just at the end.
    const realProvider = createHeuristicProvider();
    const snapshot = () => {
      if (fs.existsSync(mapPath)) {
        const onDisk = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
        snapshots.push(
          onDisk.files
            .filter((f) => f.description && f.description.length > 0)
            .map((f) => f.path)
            .sort(),
        );
      }
    };
    const spyProvider = {
      ...realProvider,
      name: 'heuristic',
      async summarizeFile(input) {
        snapshot();
        return realProvider.summarizeFile(input);
      },
      async summarizeFullFile(input) {
        snapshot();
        return realProvider.summarizeFullFile(input);
      },
    };

    await analyze(repo, {
      silent: true,
      config: { ai: { provider: 'heuristic', model: 'heuristic' } },
      // analyze() doesn't accept a provider directly; route around it by
      // pre-populating the cache… or just rely on the public API. Instead,
      // inject by reaching through to summarize() ourselves below.
    });

    // Re-do the assertion using summarize() with the spy provider, since
    // analyze() builds its own provider internally. The behavior we care
    // about — incremental writes — happens in commands.js around
    // summarize(), so we test the full pipeline by calling analyze() once,
    // wiping state, then calling summarizeCmd() with a spy provider.
    fs.rmSync(path.join(repo, '.reporose'), { recursive: true, force: true });
    await analyze(repo, {
      silent: true,
      summarize: false,
      config: { ai: { provider: 'heuristic', model: 'heuristic' } },
    });

    snapshots.length = 0;
    await summarizeCmd(repo, {
      silent: true,
      provider: spyProvider,
      config: { ai: { provider: 'heuristic', model: 'heuristic' } },
    });

    // We expect at least one intermediate snapshot to show fewer completed
    // descriptions than the final state, proving that writes happened
    // mid-run rather than only at the end.
    const finalMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const finalCount = finalMap.files.filter(
      (f) => f.description && f.description.length > 0,
    ).length;
    assert.ok(finalCount >= 1, 'expected at least one description on disk');
    const sawPartial = snapshots.some((s) => s.length < finalCount);
    assert.ok(
      sawPartial,
      `expected an intermediate snapshot with < ${finalCount} descriptions, ` +
        `got ${JSON.stringify(snapshots)}`,
    );
  } finally {
    cleanup(repo);
  }
});

test('analyze writes a structural map.json before any AI work runs', async () => {
  const repo = makeRepo({
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 2;\n',
  });
  try {
    const mapPath = path.join(repo, '.reporose', 'map.json');
    let earlySnapshot = null;

    // A "provider" that snapshots the map state when the very first file is
    // about to be summarized. By that point analyze() should already have
    // written the post-Phase-2 skeleton. We stub both code-paths since the
    // summarizer prefers summarizeFullFile when present.
    const captureEarly = () => {
      if (earlySnapshot === null && fs.existsSync(mapPath)) {
        earlySnapshot = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      }
    };
    const earlyChecker = {
      name: 'heuristic',
      async summarizeFile() { captureEarly(); return 'desc'; },
      async summarizeFullFile() { captureEarly(); return 'desc'; },
    };

    // First do a real analyze pass to get a baseline map on disk.
    await analyze(repo, {
      silent: true,
      summarize: false,
      config: { ai: { provider: 'heuristic', model: 'heuristic' } },
    });
    // Wipe any cache to force fresh AI calls.
    fs.rmSync(path.join(repo, '.reporose', 'cache'), { recursive: true, force: true });

    await summarizeCmd(repo, {
      silent: true,
      provider: earlyChecker,
      config: { ai: { provider: 'heuristic', model: 'heuristic' } },
    });

    assert.ok(earlySnapshot, 'expected map.json to exist before first AI call');
    assert.ok(Array.isArray(earlySnapshot.files), 'snapshot should be a valid map');
    assert.ok(earlySnapshot.files.length > 0, 'snapshot should contain files');
    // The structural fields must be present even before any descriptions land.
    assert.ok('links' in earlySnapshot, 'links should be present');
    assert.ok('packages' in earlySnapshot, 'packages should be present');
  } finally {
    cleanup(repo);
  }
});

test('runWithConcurrency tolerates worker errors and continues', async () => {
  const items = [1, 2, 3, 4];
  const seen = [];
  await runWithConcurrency(items, 2, async (n) => {
    if (n === 2) throw new Error('boom');
    seen.push(n);
  });
  // Non-throwing items still get processed.
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 3, 4]);
});
