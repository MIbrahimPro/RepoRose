'use strict';

/**
 * Rate limiting and streaming tests for the OpenAI-compatible provider:
 *   - 429 responses with retry-after header are parsed correctly
 *   - Groq-specific x-ratelimit-reset-tokens is parsed
 *   - SSE streaming works and invokes onStream callback
 *   - retryWithBackoff respects err.retryAfter
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createOpenAIProvider } = require('../src/ai/openai');
const { retryWithBackoff } = require('../src/ai/summarizer');

function startMockServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Rate limit header parsing                                           */
/* ------------------------------------------------------------------ */

test('openai provider parses retry-after header on 429', async () => {
  let callCount = 0;
  const { server, url } = await startMockServer(async (req, res) => {
    callCount++;
    if (callCount === 1) {
      res.writeHead(429, {
        'retry-after': '2',
        'x-ratelimit-reset-tokens': '3.5s',
        'x-ratelimit-reset-requests': '1m30s',
      });
      res.end(JSON.stringify({ error: { message: 'Rate limited' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Success after retry.' } }] }));
  });

  try {
    process.env.RATE_TEST_KEY = 'sk-test';
    const provider = createOpenAIProvider({
      base_url: url,
      api_key_env: 'RATE_TEST_KEY',
      model: 'test-model',
      min_delay_ms: 0, // disable built-in rate limiting for test speed
    });

    // This should throw with retryAfter set
    try {
      await provider.summarizeFunction({
        name: 'foo', signature: 'function foo()', file: 'a.ts', file_path: 'a.ts',
      });
      // If we get here, the first call succeeded (shouldn't happen with our mock)
    } catch (err) {
      assert.equal(err.status, 429);
      // The max of retry-after(2000ms), reset-tokens(3500ms), reset-requests(90000ms)
      assert.equal(err.retryAfter, 90000, `Expected 90000ms, got ${err.retryAfter}`);
    }
  } finally {
    delete process.env.RATE_TEST_KEY;
    await new Promise((r) => server.close(r));
  }
});

test('openai provider parses Groq-style time formats correctly', async () => {
  const { server, url } = await startMockServer(async (req, res) => {
    res.writeHead(429, {
      'x-ratelimit-reset-tokens': '7.66s',
    });
    res.end(JSON.stringify({ error: { message: 'TPM limit' } }));
  });

  try {
    process.env.GROQ_TEST_KEY = 'sk-test';
    const provider = createOpenAIProvider({
      base_url: url,
      api_key_env: 'GROQ_TEST_KEY',
      model: 'test',
      min_delay_ms: 0,
    });

    try {
      await provider.summarizeFunction({
        name: 'foo', signature: '', file: 'a.ts', file_path: 'a.ts',
      });
    } catch (err) {
      assert.equal(err.status, 429);
      assert.equal(err.retryAfter, 7660, `Expected 7660ms, got ${err.retryAfter}`);
    }
  } finally {
    delete process.env.GROQ_TEST_KEY;
    await new Promise((r) => server.close(r));
  }
});

/* ------------------------------------------------------------------ */
/* SSE streaming                                                       */
/* ------------------------------------------------------------------ */

test('openai provider streams tokens via onStream callback', async () => {
  const { server, url } = await startMockServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Send SSE chunks
    res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"."}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  try {
    process.env.STREAM_TEST_KEY = 'sk-test';
    const provider = createOpenAIProvider({
      base_url: url,
      api_key_env: 'STREAM_TEST_KEY',
      model: 'test',
      min_delay_ms: 0,
    });

    const streamedTexts = [];
    const result = await provider.summarizeFunction(
      { name: 'foo', signature: '', file: 'a.ts', file_path: 'a.ts' },
      (text) => streamedTexts.push(text),
    );

    assert.ok(streamedTexts.length >= 1, 'onStream should have been called');
    assert.equal(result, 'Hello world.');
  } finally {
    delete process.env.STREAM_TEST_KEY;
    await new Promise((r) => server.close(r));
  }
});

/* ------------------------------------------------------------------ */
/* retryWithBackoff respects err.retryAfter                            */
/* ------------------------------------------------------------------ */

test('retryWithBackoff uses err.retryAfter when available', async () => {
  let attempts = 0;
  const startTime = Date.now();

  const result = await retryWithBackoff(
    () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error('Rate limited');
        err.status = 429;
        err.retryAfter = 100; // 100ms
        throw err;
      }
      return 'success';
    },
    {
      delays: [50, 100, 200], // default delays are shorter
    },
  );

  const elapsed = Date.now() - startTime;
  assert.equal(result, 'success');
  assert.equal(attempts, 2);
  // Should have waited at least 100ms (the retryAfter), not 50ms (the default delay)
  assert.ok(elapsed >= 95, `Should have waited ~100ms, actual: ${elapsed}ms`);
});
