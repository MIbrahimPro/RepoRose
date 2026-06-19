'use strict';

/**
 * Phase 6 — new provider integrations + AGENTS.md context:
 *   - Anthropic provider (Messages API)
 *   - Ollama Cloud provider (bearer auth on top of /api/chat)
 *   - Local provider tier system
 *   - AGENTS.md repo context attaches to prompts when context window allows
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  createAnthropicProvider,
  RECOMMENDED_MODELS: ANTHROPIC_MODELS,
} = require('../src/ai/anthropic');
const {
  createOllamaProvider,
  CLOUD_MODELS: OLLAMA_CLOUD_MODELS,
} = require('../src/ai/ollama');
const { TIERS: LOCAL_TIERS, resolveTier } = require('../src/ai/local');
const {
  buildFileInput,
  buildFullFileInput,
  renderFilePrompt,
  renderFullFilePrompt,
} = require('../src/ai/prompts');
const {
  DEFAULT_CONFIG,
  KNOWN_PROVIDERS,
  PROVIDER_ALIASES,
  applyModelFlag,
  applyApiKeyEnv,
  applyLocalTier,
  presetModelLabel,
} = require('../src/ai/config');

/* ------------------------------------------------------------------ */
/* In-process HTTP fixture                                             */
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
/* Anthropic provider                                                  */
/* ------------------------------------------------------------------ */

test('anthropic provider posts to /messages with x-api-key + anthropic-version', async () => {
  let capturedHeaders = null;
  let capturedBody = null;
  const { server, url } = await startMockServer(async (req, res) => {
    capturedHeaders = req.headers;
    capturedBody = await jsonBody(req);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      content: [{ type: 'text', text: 'Renders an authenticated dashboard.' }],
    }));
  });

  process.env.TEST_ANTHROPIC_KEY = 'sk-ant-test';
  try {
    const provider = createAnthropicProvider({
      base_url: url,
      api_key_env: 'TEST_ANTHROPIC_KEY',
      model: 'claude-haiku-4-5',
    });
    const desc = await provider.summarizeFile(
      buildFileInput({
        name: 'index.ts', path: 'src/index.ts', language: 'typescript',
        type: 'code', size_bytes: 100, imports: [], exported: [], functions: [],
      }, 'export default 42;\n'),
    );
    assert.equal(desc, 'Renders an authenticated dashboard.');
    assert.equal(capturedHeaders['x-api-key'], 'sk-ant-test');
    assert.match(capturedHeaders['anthropic-version'], /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(capturedBody.model, 'claude-haiku-4-5');
    assert.ok(Array.isArray(capturedBody.messages));
    assert.equal(capturedBody.messages[0].role, 'user');
    assert.ok(typeof capturedBody.system === 'string' && capturedBody.system.length > 0);
  } finally {
    delete process.env.TEST_ANTHROPIC_KEY;
    server.close();
  }
});

test('anthropic provider throws when api key env is missing', () => {
  delete process.env.NONEXISTENT_ANTHROPIC_KEY;
  assert.throws(
    () => createAnthropicProvider({ api_key_env: 'NONEXISTENT_ANTHROPIC_KEY' }),
    /ANTHROPIC|environment variable/,
  );
});

test('anthropic provider parses retry-after on 429', async () => {
  let callCount = 0;
  const { server, url } = await startMockServer(async (req, res) => {
    callCount++;
    res.writeHead(429, { 'retry-after': '2' });
    res.end('rate limited');
  });

  process.env.TEST_ANTHROPIC_KEY = 'sk-ant-test';
  try {
    const provider = createAnthropicProvider({
      base_url: url,
      api_key_env: 'TEST_ANTHROPIC_KEY',
    });
    let caught = null;
    try {
      await provider.summarizeFunction({
        name: 'foo', signature: 'foo()', file: 'a.ts', file_path: 'a.ts', language: 'ts',
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'should have thrown');
    assert.equal(caught.status, 429);
    assert.equal(caught.retryAfter, 2000);
    assert.equal(callCount, 1);
  } finally {
    delete process.env.TEST_ANTHROPIC_KEY;
    server.close();
  }
});

test('anthropic recommended models include claude-haiku-4-5 first', () => {
  assert.ok(Array.isArray(ANTHROPIC_MODELS) && ANTHROPIC_MODELS.length > 0);
  assert.equal(ANTHROPIC_MODELS[0].id, 'claude-haiku-4-5');
});

/* ------------------------------------------------------------------ */
/* Ollama Cloud (bearer auth)                                          */
/* ------------------------------------------------------------------ */

test('ollama provider sends Authorization: Bearer when api_key_env is set', async () => {
  let capturedAuth = null;
  let capturedBody = null;
  const { server, url } = await startMockServer(async (req, res) => {
    if (req.url === '/api/tags') {
      res.setHeader('Content-Type', 'application/json');
      // Cloud `/api/tags` is allowed to omit the requested model — the
      // provider should NOT do membership checks for cloud installs.
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    capturedAuth = req.headers.authorization;
    capturedBody = await jsonBody(req);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: { content: 'Cloud-summarized.' } }));
  });

  process.env.TEST_OLLAMA_CLOUD_KEY = 'ollama-test-token';
  try {
    const provider = await createOllamaProvider({
      base_url: url,
      api_key_env: 'TEST_OLLAMA_CLOUD_KEY',
      model: 'gpt-oss:20b-cloud',
      name: 'ollama-cloud',
    });
    assert.equal(provider.name, 'ollama-cloud');
    const desc = await provider.summarizeFile(
      buildFileInput({
        name: 'a.ts', path: 'a.ts', language: 'ts', type: 'code',
        size_bytes: 10, imports: [], exported: [], functions: [],
      }, 'x'),
    );
    assert.equal(desc, 'Cloud-summarized.');
    assert.equal(capturedAuth, 'Bearer ollama-test-token');
    assert.equal(capturedBody.model, 'gpt-oss:20b-cloud');
  } finally {
    delete process.env.TEST_OLLAMA_CLOUD_KEY;
    server.close();
  }
});

test('ollama provider throws when api_key_env is set but unset in env', async () => {
  delete process.env.NONEXISTENT_OLLAMA_KEY;
  await assert.rejects(
    () => createOllamaProvider({
      base_url: 'http://localhost:1',
      api_key_env: 'NONEXISTENT_OLLAMA_KEY',
      name: 'ollama-cloud',
    }),
    /environment variable|NONEXISTENT_OLLAMA_KEY/,
  );
});

test('ollama-cloud is a known provider in the config schema', () => {
  assert.ok(KNOWN_PROVIDERS.has('ollama-cloud'));
  assert.ok(KNOWN_PROVIDERS.has('anthropic'));
  assert.equal(PROVIDER_ALIASES.claude, 'anthropic');
  assert.equal(PROVIDER_ALIASES.ollamacloud, 'ollama-cloud');
});

test('ollama cloud model list has gpt-oss:20b-cloud first', () => {
  assert.ok(Array.isArray(OLLAMA_CLOUD_MODELS) && OLLAMA_CLOUD_MODELS.length > 0);
  assert.equal(OLLAMA_CLOUD_MODELS[0].id, 'gpt-oss:20b-cloud');
});

/* ------------------------------------------------------------------ */
/* applyModelFlag / applyApiKeyEnv routing                             */
/* ------------------------------------------------------------------ */

test('applyModelFlag routes "anthropic" and aliases', () => {
  let cfg = applyModelFlag(DEFAULT_CONFIG, 'anthropic');
  assert.equal(cfg.ai.provider, 'anthropic');
  cfg = applyModelFlag(DEFAULT_CONFIG, 'claude');
  assert.equal(cfg.ai.provider, 'anthropic');
});

test('applyModelFlag routes "ollama-cloud" and aliases', () => {
  let cfg = applyModelFlag(DEFAULT_CONFIG, 'ollama-cloud');
  assert.equal(cfg.ai.provider, 'ollama-cloud');
  cfg = applyModelFlag(DEFAULT_CONFIG, 'ollamacloud');
  assert.equal(cfg.ai.provider, 'ollama-cloud');
});

test('applyApiKeyEnv targets the active provider for new providers', () => {
  let cfg = applyModelFlag(DEFAULT_CONFIG, 'anthropic');
  cfg = applyApiKeyEnv(cfg, 'MY_CLAUDE_KEY');
  assert.equal(cfg.ai.anthropic.api_key_env, 'MY_CLAUDE_KEY');

  cfg = applyModelFlag(DEFAULT_CONFIG, 'ollama-cloud');
  cfg = applyApiKeyEnv(cfg, 'MY_OLLAMA_KEY');
  assert.equal(cfg.ai['ollama-cloud'].api_key_env, 'MY_OLLAMA_KEY');
});

test('presetModelLabel surfaces the right model for new providers', () => {
  let cfg = applyModelFlag(DEFAULT_CONFIG, 'anthropic');
  assert.equal(presetModelLabel(cfg), 'claude-haiku-4-5');
  cfg = applyModelFlag(DEFAULT_CONFIG, 'ollama-cloud');
  assert.equal(presetModelLabel(cfg), 'gpt-oss:20b-cloud');
});

/* ------------------------------------------------------------------ */
/* Local provider tiers                                                */
/* ------------------------------------------------------------------ */

test('local TIERS expose monotonically increasing budgets', () => {
  assert.ok(LOCAL_TIERS.low.contextSize < LOCAL_TIERS.medium.contextSize);
  assert.ok(LOCAL_TIERS.medium.contextSize < LOCAL_TIERS.high.contextSize);
  assert.ok(LOCAL_TIERS.low.fileTokens < LOCAL_TIERS.medium.fileTokens);
  assert.ok(LOCAL_TIERS.medium.fileTokens < LOCAL_TIERS.high.fileTokens);
});

test('resolveTier defaults to low for unknown / missing values', () => {
  assert.equal(resolveTier({}).contextSize, LOCAL_TIERS.low.contextSize);
  assert.equal(resolveTier({ tier: 'wat' }).contextSize, LOCAL_TIERS.low.contextSize);
  assert.equal(resolveTier({ tier: 'HIGH' }).contextSize, LOCAL_TIERS.high.contextSize);
});

test('applyLocalTier validates input', () => {
  const cfg = applyLocalTier(DEFAULT_CONFIG, 'medium');
  assert.equal(cfg.ai.local.tier, 'medium');
  assert.throws(() => applyLocalTier(DEFAULT_CONFIG, 'extreme'), /Invalid local tier/);
});

/* ------------------------------------------------------------------ */
/* AGENTS.md repo context propagation                                  */
/* ------------------------------------------------------------------ */

test('buildFileInput stores repoContext and renderFilePrompt embeds it', () => {
  const file = {
    name: 'foo.ts', path: 'src/foo.ts', language: 'typescript', type: 'code',
    size_bytes: 200, imports: [], exported: [], functions: [],
  };
  const input = buildFileInput(file, 'snippet', { repoContext: 'Repo overview line.' });
  assert.equal(input.repoContext, 'Repo overview line.');
  const rendered = renderFilePrompt(input);
  assert.match(rendered, /Repo overview line\./);
  assert.match(rendered, /AGENTS\.md/);
});

test('buildFileInput omits the AGENTS section when repoContext is empty', () => {
  const file = {
    name: 'foo.ts', path: 'src/foo.ts', language: 'typescript', type: 'code',
    size_bytes: 200, imports: [], exported: [], functions: [],
  };
  const input = buildFileInput(file, 'snippet'); // no repoContext
  assert.equal(input.repoContext, '');
  const rendered = renderFilePrompt(input);
  assert.doesNotMatch(rendered, /AGENTS\.md/);
});

test('buildFullFileInput passes repoContext through to renderFullFilePrompt', () => {
  const file = {
    name: 'a.ts', path: 'a.ts', language: 'typescript', type: 'code',
    size_bytes: 10, imports: [], exported: [], functions: [],
  };
  const input = buildFullFileInput(file, ['contents'], { repoContext: 'Project does X.' });
  assert.equal(input.repoContext, 'Project does X.');
  const rendered = renderFullFilePrompt(input, 0, '');
  assert.match(rendered, /Project does X\./);
  assert.match(rendered, /AGENTS\.md/);
});

/* ------------------------------------------------------------------ */
/* End-to-end: AGENTS.md is attached to prompts during summarization   */
/* ------------------------------------------------------------------ */

test('summarize attaches AGENTS.md content to prompts when ctx allows', async () => {
  const { summarize } = require('../src/ai/summarizer');
  const { mapDependencies } = require('../src/core/mapper');
  const { scan } = require('../src/core/scanner');

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'reporose-agents-'));
  try {
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Test repo\nThis project sums numbers.\n');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const sum = (a, b) => a + b;\n');

    const map = mapDependencies(await scan(repo));
    const seenPrompts = [];
    const provider = {
      name: 'spy', model: 'spy', contextSize: 8192,
      async summarizeFile(input) {
        seenPrompts.push(JSON.stringify(input));
        return 'desc';
      },
      async summarizeFullFile(input) {
        // Capture the actual rendered prompt; that's what the model sees.
        seenPrompts.push(input.prompt || JSON.stringify(input));
        return 'desc';
      },
      async close() {},
    };

    await summarize(map, { repoPath: repo, provider, silent: true });

    // Some path should contain the AGENTS.md content.
    const all = seenPrompts.join('\n---\n');
    assert.match(all, /sums numbers/);
    assert.match(all, /AGENTS\.md/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
