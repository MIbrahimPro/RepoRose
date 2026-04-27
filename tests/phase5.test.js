'use strict';

/**
 * Phase 5 — provider extensibility:
 *   - Ollama
 *   - generic OpenAI-compatible
 *   - 'none' provider (skip Phase 3)
 *   - user-level presets
 *   - prompt truncation safeguard
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { summarize, selectProvider } = require('../src/ai/summarizer');
const { createOllamaProvider, postProcess } = require('../src/ai/ollama');
const { createOpenAIProvider } = require('../src/ai/openai');
const {
  applyModelFlag,
  applyBaseUrl,
  applyModelName,
  applyOllamaOption,
  applyApiKeyEnv,
  loadConfig,
  savePreset,
  loadPreset,
  applyPreset,
  listPresets,
  deletePreset,
  presetsPath,
} = require('../src/ai/config');

/* ------------------------------------------------------------------ */
/* In-process HTTP fixtures                                            */
/* ------------------------------------------------------------------ */

function startMockServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* Ollama provider                                                     */
/* ------------------------------------------------------------------ */

test('ollama: postProcess strips <think> blocks and chat prefixes', () => {
  assert.equal(
    postProcess('<think>reason here</think>Answer: It does X.'),
    'It does X.',
  );
  assert.equal(
    postProcess('Description: Sums two numbers.   '),
    'Sums two numbers.',
  );
  assert.equal(postProcess(''), '');
});

test('ollama provider talks to /api/chat with merged options', async () => {
  let capturedBody = null;
  const { server, url } = await startMockServer(async (req, res) => {
    if (req.url === '/api/tags') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:3b-instruct-q4_K_M' }] }));
      return;
    }
    if (req.url === '/api/chat') {
      capturedBody = await jsonBody(req);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'A short summary.' } }));
      return;
    }
    res.statusCode = 404; res.end();
  });

  try {
    const provider = await createOllamaProvider({
      base_url: url,
      model: 'qwen2.5-coder:3b-instruct-q4_K_M',
      options: { num_ctx: 32000, temperature: 0, num_predict: 10000 },
    });
    const desc = await provider.summarizeFile({
      name: 'a.ts', path: 'src/a.ts', language: 'typescript', size_bytes: 100,
      imports: [], exported: [], functions: [], snippet: 'export const x = 1;',
    });
    assert.equal(desc, 'A short summary.');
    assert.equal(capturedBody.model, 'qwen2.5-coder:3b-instruct-q4_K_M');
    assert.equal(capturedBody.stream, false);
    assert.equal(capturedBody.options.num_ctx, 32000);
    assert.equal(capturedBody.options.temperature, 0);
    // File summary is capped at 400 tokens (4-6 sentences ≈ 150-300 tokens).
    assert.equal(capturedBody.options.num_predict, 400);
    assert.equal(capturedBody.messages[0].role, 'system');
    assert.equal(capturedBody.messages[1].role, 'user');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('ollama provider rejects when model is missing on the server', async () => {
  const { server, url } = await startMockServer((req, res) => {
    if (req.url === '/api/tags') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'llama3:8b' }] }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  try {
    await assert.rejects(
      createOllamaProvider({ base_url: url, model: 'qwen2.5-coder:3b-instruct-q4_K_M' }),
      (err) => err.code === 'OLLAMA_MODEL_MISSING',
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('ollama provider rejects when server is unreachable', async () => {
  await assert.rejects(
    createOllamaProvider({ base_url: 'http://127.0.0.1:1', model: 'foo' }),
    (err) => err.code === 'OLLAMA_UNREACHABLE',
  );
});

test('ollama: long prompts are truncated to fit num_ctx', async () => {
  let capturedPrompt = null;
  const { server, url } = await startMockServer(async (req, res) => {
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: 'tiny' }] }));
      return;
    }
    if (req.url === '/api/chat') {
      const body = await jsonBody(req);
      capturedPrompt = body.messages[body.messages.length - 1].content;
      res.end(JSON.stringify({ message: { content: 'ok.' } }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  try {
    // num_ctx 1000, num_predict 200 → max prompt chars = max(1000, (1000-200)*4) = 3200
    const provider = await createOllamaProvider({
      base_url: url, model: 'tiny',
      options: { num_ctx: 1000, num_predict: 200 },
    });
    const huge = 'x'.repeat(50000);
    await provider.summarizeFile({
      name: 'big.ts', path: 'src/big.ts', language: 'typescript', size_bytes: huge.length,
      imports: [], exported: [], functions: [],
      snippet: huge,
    });
    assert.ok(capturedPrompt.length < 5000, `prompt should be truncated, got ${capturedPrompt.length}`);
    assert.match(capturedPrompt, /truncated/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/* ------------------------------------------------------------------ */
/* OpenAI-compatible provider                                          */
/* ------------------------------------------------------------------ */

test('openai provider posts to /chat/completions with bearer auth', async () => {
  let capturedAuth = null;
  let capturedBody = null;
  const { server, url } = await startMockServer(async (req, res) => {
    capturedAuth = req.headers.authorization;
    capturedBody = await jsonBody(req);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A summary.' } }] }));
  });
  try {
    process.env.MY_TEST_KEY = 'sk-test-123';
    const provider = createOpenAIProvider({
      base_url: url,
      api_key_env: 'MY_TEST_KEY',
      model: 'test-model',
    });
    const desc = await provider.summarizeFunction({
      name: 'foo', signature: 'function foo()', file: 'a.ts', file_path: 'a.ts',
    });
    assert.equal(desc, 'A summary.');
    assert.equal(capturedAuth, 'Bearer sk-test-123');
    assert.equal(capturedBody.model, 'test-model');
  } finally {
    delete process.env.MY_TEST_KEY;
    await new Promise((r) => server.close(r));
  }
});

test('openai provider throws when api key env is missing', () => {
  delete process.env.NONEXISTENT_OPENAI_KEY;
  assert.throws(
    () => createOpenAIProvider({ api_key_env: 'NONEXISTENT_OPENAI_KEY', model: 'foo' }),
    (err) => err.code === 'OPENAI_KEY_MISSING',
  );
});

test('openai provider supports keyless local servers (api_key_env: empty)', async () => {
  let capturedAuth = 'unset';
  const { server, url } = await startMockServer(async (req, res) => {
    capturedAuth = req.headers.authorization;
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok.' } }] }));
  });
  try {
    const provider = createOpenAIProvider({
      base_url: url,
      api_key_env: '', // no auth required
      model: 'lmstudio-local',
    });
    await provider.summarizeFunction({ name: 'x', signature: '', file: '', file_path: '' });
    assert.equal(capturedAuth, undefined);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/* ------------------------------------------------------------------ */
/* Provider selection (full matrix)                                    */
/* ------------------------------------------------------------------ */

test('selectProvider: ollama unavailable → SKIP', async () => {
  const messages = [];
  const provider = await selectProvider(
    { ai: { provider: 'ollama', ollama: { base_url: 'http://127.0.0.1:1', model: 'foo' } } },
    (level, msg) => messages.push(`${level}:${msg}`),
  );
  assert.equal(provider.skip, true);
  assert.ok(messages.some((m) => /Ollama unavailable/.test(m)));
});

test('selectProvider: openai missing key → SKIP', async () => {
  delete process.env.PHASE5_NO_KEY;
  const messages = [];
  const provider = await selectProvider(
    { ai: { provider: 'openai', openai: { api_key_env: 'PHASE5_NO_KEY', model: 'gpt-4o-mini' } } },
    (level, msg) => messages.push(`${level}:${msg}`),
  );
  assert.equal(provider.skip, true);
  assert.ok(messages.some((m) => /OpenAI unavailable/.test(m)));
});

/* ------------------------------------------------------------------ */
/* summarize() with provider 'none' / SKIP                             */
/* ------------------------------------------------------------------ */

test("summarize with provider 'none' leaves descriptions empty and writes nothing to cache", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-skip-'));
  try {
    const map = {
      files: [
        {
          id: 'file_001', name: 'a.ts', path: 'a.ts', type: 'code', language: 'typescript',
          size_bytes: 1, hash: 'h1',
          functions: [{ id: 'fn_001_01', name: 'foo', signature: 'function foo()' }],
        },
      ],
    };
    const stats = await summarize(map, {
      repoPath: tmp,
      config: { ai: { provider: 'none' } },
    });
    assert.equal(stats.skipped, true);
    assert.equal(stats.provider, 'none');
    assert.equal(map.files[0].description, '');
    assert.equal(map.files[0].functions[0].description, '');
    // No cache file should be written.
    const cacheFile = path.join(tmp, '.reporose', 'cache', 'summaries.json');
    assert.equal(fs.existsSync(cacheFile), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Config helpers                                                      */
/* ------------------------------------------------------------------ */

test('applyModelFlag handles ollama / openai / none / aliases', () => {
  const base = loadConfig('/tmp/never-exists-xyz');
  assert.equal(applyModelFlag(base, 'ollama').ai.provider, 'ollama');
  assert.equal(applyModelFlag(base, 'openai').ai.provider, 'openai');
  assert.equal(applyModelFlag(base, 'none').ai.provider, 'none');
  assert.equal(applyModelFlag(base, 'off').ai.provider, 'none');
  assert.equal(applyModelFlag(base, 'cloud').ai.provider, 'openrouter');
  assert.equal(applyModelFlag(base, 'offline').ai.provider, 'heuristic');
});

test('applyBaseUrl / applyModelName / applyOllamaOption mutate the active provider', () => {
  let cfg = loadConfig('/tmp/never-exists-xyz');
  cfg = applyModelFlag(cfg, 'ollama');
  cfg = applyBaseUrl(cfg, 'http://my-host:11434');
  cfg = applyModelName(cfg, 'qwen2.5-coder:7b');
  cfg = applyOllamaOption(cfg, 'num_ctx', 8000);
  cfg = applyOllamaOption(cfg, 'temperature', 0.1);
  assert.equal(cfg.ai.ollama.base_url, 'http://my-host:11434');
  assert.equal(cfg.ai.ollama.model, 'qwen2.5-coder:7b');
  assert.equal(cfg.ai.ollama.options.num_ctx, 8000);
  assert.equal(cfg.ai.ollama.options.temperature, 0.1);

  let cfg2 = loadConfig('/tmp/never-exists-xyz');
  cfg2 = applyModelFlag(cfg2, 'openai');
  cfg2 = applyApiKeyEnv(cfg2, 'MY_OPENAI_KEY');
  cfg2 = applyModelName(cfg2, 'gpt-4o-mini');
  assert.equal(cfg2.ai.openai.api_key_env, 'MY_OPENAI_KEY');
  assert.equal(cfg2.ai.openai.model, 'gpt-4o-mini');
});

/* ------------------------------------------------------------------ */
/* Presets                                                              */
/* ------------------------------------------------------------------ */

test('preset save / list / use / delete round-trip (sandboxed HOME)', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-home-'));
  const oldHome = process.env.HOME;
  const oldUserprofile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  try {
    // Sanity: presets file lives under our sandboxed home.
    assert.ok(presetsPath().startsWith(tmpHome));

    let cfg = loadConfig('/tmp/never-exists-xyz');
    cfg = applyModelFlag(cfg, 'ollama');
    cfg = applyOllamaOption(cfg, 'num_ctx', 32000);
    cfg.ai.ollama.model = 'qwen2.5-coder:3b-instruct-q4_K_M';

    savePreset('my-ollama', cfg);
    const list = listPresets();
    assert.ok(list.some((p) => p.name === 'my-ollama' && p.provider === 'ollama'));
    assert.equal(list.find((p) => p.name === 'my-ollama').model, 'qwen2.5-coder:3b-instruct-q4_K_M');

    const loaded = loadPreset('my-ollama');
    assert.equal(loaded.ai.provider, 'ollama');
    assert.equal(loaded.ai.ollama.options.num_ctx, 32000);

    // applyPreset onto a different config keeps non-AI fields untouched.
    let other = loadConfig('/tmp/never-exists-xyz');
    other.someOtherKey = 42;
    other = applyPreset(other, 'my-ollama');
    assert.equal(other.ai.provider, 'ollama');
    assert.equal(other.someOtherKey, 42);

    assert.equal(deletePreset('my-ollama'), true);
    assert.equal(deletePreset('my-ollama'), false);
  } finally {
    if (oldHome !== undefined) process.env.HOME = oldHome; else delete process.env.HOME;
    if (oldUserprofile !== undefined) process.env.USERPROFILE = oldUserprofile; else delete process.env.USERPROFILE;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('savePreset rejects invalid names but accepts dots, hyphens, underscores', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    assert.throws(() => savePreset('bad name with spaces', {}), /alphanumeric/);
    assert.throws(() => savePreset('', {}), /alphanumeric/);
    // Dots and version-style names are allowed.
    assert.doesNotThrow(() => savePreset('ollama-qwen2.5-coder-3b', {}));
  } finally {
    if (oldHome !== undefined) process.env.HOME = oldHome; else delete process.env.HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* `reporose init` interactive wizard                                  */
/* ------------------------------------------------------------------ */

const { spawnSync } = require('node:child_process');

function runInit(repoPath, answers, env = {}) {
  // The init wizard reads stdin line-by-line; feeding answers via a piped
  // child process exercises the same code path users hit interactively.
  const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');
  const result = spawnSync('node', [cliPath, 'init', repoPath], {
    input: answers.join('\n') + '\n',
    encoding: 'utf8',
    env: { ...process.env, ...env, HOME: env.HOME || process.env.HOME },
    timeout: 15_000,
  });
  return result;
}

test('init wizard: heuristic provider writes correct config', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-init-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-home-'));
  try {
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), '{"name":"x"}');
    // Inputs: 1=heuristic, n=no preset, n=no analyze
    const result = runInit(tmpRepo, ['1', 'n', 'n'], { HOME: tmpHome });
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpRepo, '.reporose', 'config.json'), 'utf8'),
    );
    assert.equal(cfg.ai.provider, 'heuristic');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('init wizard: "none" provider writes correct config', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-init-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-home-'));
  try {
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), '{"name":"x"}');
    // Inputs: 6=none, n=no preset, n=no analyze
    const result = runInit(tmpRepo, ['6', 'n', 'n'], { HOME: tmpHome });
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpRepo, '.reporose', 'config.json'), 'utf8'),
    );
    assert.equal(cfg.ai.provider, 'none');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('init wizard: openai provider with defaults persists base_url, model, api_key_env', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-init-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-home-'));
  try {
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), '{"name":"x"}');
    // Inputs:
    //   3   = OpenAI
    //   ""  = default env var (OPENAI_API_KEY)
    //   n   = no custom base URL
    //   ""  = default model (gpt-4o-mini)
    //   n   = no preset
    //   n   = no analyze
    const result = runInit(tmpRepo, ['3', '', 'n', '', 'n', 'n'], { HOME: tmpHome });
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpRepo, '.reporose', 'config.json'), 'utf8'),
    );
    assert.equal(cfg.ai.provider, 'openai');
    assert.equal(cfg.ai.openai.base_url, 'https://api.openai.com/v1');
    assert.equal(cfg.ai.openai.model, 'gpt-4o-mini');
    assert.equal(cfg.ai.openai.api_key_env, 'OPENAI_API_KEY');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('init wizard: openrouter provider with defaults persists model and api_key_env', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-init-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-home-'));
  try {
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), '{"name":"x"}');
    // Inputs: 4=OpenRouter, "", n, "", n, n
    const result = runInit(tmpRepo, ['4', '', 'n', '', 'n', 'n'], { HOME: tmpHome });
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpRepo, '.reporose', 'config.json'), 'utf8'),
    );
    assert.equal(cfg.ai.provider, 'openrouter');
    assert.equal(cfg.ai.openrouter.api_key_env, 'OPENROUTER_API_KEY');
    assert.equal(cfg.ai.openrouter.model, 'meta-llama/llama-3.2-3b-instruct:free');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('init wizard: invalid choice re-prompts until valid', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-init-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-home-'));
  try {
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), '{"name":"x"}');
    // Inputs: 99=invalid, abc=invalid, 1=heuristic, n, n
    const result = runInit(tmpRepo, ['99', 'abc', '1', 'n', 'n'], { HOME: tmpHome });
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /Invalid choice/);
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpRepo, '.reporose', 'config.json'), 'utf8'),
    );
    assert.equal(cfg.ai.provider, 'heuristic');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
