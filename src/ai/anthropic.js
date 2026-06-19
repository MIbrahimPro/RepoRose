'use strict';

const { renderFilePrompt, renderFunctionPrompt } = require('./prompts');
const { getSecret } = require('../utils/secrets');

/**
 * Anthropic provider — talks to the Messages API at
 * `POST <base_url>/messages`. Uses `x-api-key` header auth and the
 * `anthropic-version` pinned date.
 *
 * Default model is **claude-haiku-4-5** because it is the cheapest +
 * fastest model in Anthropic's lineup that still produces high-quality
 * code summaries — exactly the trade-off this tool wants.
 *
 * Pricing reference (subject to change): Haiku 4.5 ≈ $1/MTok input,
 * $5/MTok output, with generous TPM/RPM limits even on the free tier.
 *
 * Configure via:
 *   reporose config --model anthropic \
 *     --api-key-env ANTHROPIC_API_KEY \
 *     --model-name claude-haiku-4-5
 */

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY';
const ANTHROPIC_VERSION = '2023-06-01';

/** A small curated list shown in the init wizard. Lowest cost first. */
const RECOMMENDED_MODELS = [
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    hint: 'fastest + cheapest, great for summaries (recommended)',
  },
  {
    id: 'claude-3-5-haiku-latest',
    label: 'Claude 3.5 Haiku',
    hint: 'older haiku, very cheap',
  },
  {
    id: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    hint: 'higher quality, ~5× the cost',
  },
];

function trimDescription(text) {
  if (!text) return '';
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\s+/g, ' ');
}

async function messagesComplete({
  baseUrl,
  apiKey,
  model,
  prompt,
  system,
  maxTokens,
  temperature,
  timeoutMs,
  signal,
  onStream,
}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 60_000);
  if (signal) signal.addEventListener('abort', () => controller.abort());

  try {
    const body = {
      model,
      max_tokens: maxTokens || 512,
      temperature: temperature == null ? 0.2 : temperature,
      messages: [{ role: 'user', content: prompt }],
      stream: !!onStream,
    };
    if (system) body.system = system;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Anthropic HTTP ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      // Anthropic returns retry-after on 429 / 529; honour it.
      if (res.status === 429 || res.status === 529) {
        const ra = res.headers.get('retry-after');
        if (ra) err.retryAfter = parseFloat(ra) * 1000;
      }
      throw err;
    }

    if (onStream) {
      // SSE stream: each event line is `data: {json}` with type 'content_block_delta'
      let fullText = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        const textChunk = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        for (const line of textChunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const data = JSON.parse(payload);
            if (
              data.type === 'content_block_delta' &&
              data.delta &&
              data.delta.type === 'text_delta' &&
              typeof data.delta.text === 'string'
            ) {
              fullText += data.delta.text;
              onStream(trimDescription(fullText));
            }
          } catch (_e) {
            /* ignore malformed line */
          }
        }
      }
      return trimDescription(fullText);
    }

    const json = await res.json();
    // Non-streaming response shape: { content: [{ type: 'text', text: '...' }, ...] }
    const blocks = Array.isArray(json && json.content) ? json.content : [];
    const text = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    return trimDescription(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} cfg
 * @param {string} [cfg.base_url]    default https://api.anthropic.com/v1
 * @param {string} [cfg.api_key_env] default ANTHROPIC_API_KEY
 * @param {string} [cfg.model]       default claude-haiku-4-5
 * @param {number} [cfg.timeout_ms]  default 60000
 * @param {number} [cfg.temperature] default 0.2
 * @param {number} [cfg.context_size] used by the summarizer to decide chunking
 */
function createAnthropicProvider(cfg = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available — Node 18+ is required');
  }
  const baseUrl = cfg.base_url || DEFAULT_BASE_URL;
  const model = cfg.model || DEFAULT_MODEL;
  const apiKeyEnv = cfg.api_key_env == null ? DEFAULT_API_KEY_ENV : cfg.api_key_env;
  const apiKey = apiKeyEnv ? getSecret(apiKeyEnv) : '';
  if (!apiKey) {
    const err = new Error(
      `Anthropic provider needs the ${apiKeyEnv} environment variable. ` +
        'Set it in your shell, in a .env file, or run `reporose config --secret set ' +
        `${apiKeyEnv} <key>` +
        ' to store it securely.',
    );
    err.code = 'ANTHROPIC_KEY_MISSING';
    throw err;
  }

  const timeoutMs = cfg.timeout_ms || 60_000;
  const temperature = cfg.temperature == null ? 0.2 : cfg.temperature;
  // Haiku models advertise 200K context; default to a conservative 100K so we
  // don't blow up token budgets on huge files.
  const contextSize = cfg.context_size || 100_000;

  const fileSystem =
    'You are a code analysis assistant. Write one compact paragraph of 4-6 sentences explaining what the file actually does, including behavior, workflow, state/effects, external interactions, and how it fits into the codebase. No markdown, no preamble.';
  const fnSystem =
    'You are a code analysis assistant. Reply with exactly 1-2 short sentences describing what the function does. No markdown, no preamble.';
  const fullFileSystem =
    'You are a code analysis assistant analyzing complete source code. Write one compact technical paragraph of 5-8 sentences explaining what the file actually does, which workflows or UI/backend behaviors it implements, important state/effects/API/auth/search/form logic, and how it fits into the codebase. No markdown, no preamble.';

  return {
    name: 'anthropic',
    model,
    contextSize,
    async summarizeFile(input, onStream) {
      return messagesComplete({
        baseUrl, apiKey, model,
        prompt: renderFilePrompt(input),
        system: fileSystem,
        maxTokens: 400,
        temperature, timeoutMs, onStream,
      });
    },
    async summarizeFullFile(input, onStream) {
      const maxTokens = input.isLastChunk ? 600 : 300;
      return messagesComplete({
        baseUrl, apiKey, model,
        prompt: input.prompt,
        system: fullFileSystem,
        maxTokens, temperature, timeoutMs, onStream,
      });
    },
    async summarizeFunction(input, onStream) {
      return messagesComplete({
        baseUrl, apiKey, model,
        prompt: renderFunctionPrompt(input),
        system: fnSystem,
        maxTokens: 120,
        temperature, timeoutMs, onStream,
      });
    },
    async close() {},
  };
}

module.exports = {
  createAnthropicProvider,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_API_KEY_ENV,
  ANTHROPIC_VERSION,
  RECOMMENDED_MODELS,
};
