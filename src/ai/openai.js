'use strict';

const { renderFilePrompt, renderFunctionPrompt } = require('./prompts');
const { getSecret } = require('../utils/secrets');

/**
 * Generic OpenAI-compatible provider.
 *
 * Works with any service that implements `POST <base_url>/chat/completions`,
 * including:
 *   - api.openai.com           (`OPENAI_API_KEY`)
 *   - api.together.xyz/v1      (`TOGETHER_API_KEY`)
 *   - api.groq.com/openai/v1   (`GROQ_API_KEY`)
 *   - api.deepseek.com/v1      (`DEEPSEEK_API_KEY`)
 *   - localhost:1234/v1        (LM Studio, no key needed — set api_key_env: '')
 *   - localhost:11434/v1       (Ollama OpenAI-compat shim)
 *
 * Configure via:
 *   reporose config --model openai \
 *     --base-url https://api.openai.com/v1 \
 *     --api-key-env OPENAI_API_KEY \
 *     --model-name gpt-4o-mini
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY';

function trimDescription(text) {
  if (!text) return '';
  return String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
}

async function chatComplete({ baseUrl, apiKey, model, prompt, system, maxTokens, temperature, timeoutMs, signal, headers, onStream }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 60_000);
  if (signal) signal.addEventListener('abort', () => controller.abort());

  try {
    const reqHeaders = { 'Content-Type': 'application/json', ...(headers || {}) };
    if (apiKey) reqHeaders.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify({
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens,
        temperature: temperature == null ? 0.2 : temperature,
        stream: !!onStream,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let retryAfter = null;
      if (res.status === 429) {
        // Parse standard and Groq-specific rate limit headers
        const retryAfterHeader = res.headers.get('retry-after');
        const resetTokensHeader = res.headers.get('x-ratelimit-reset-tokens');
        const resetRequestsHeader = res.headers.get('x-ratelimit-reset-requests');

        let maxWaitMs = 0;
        
        if (retryAfterHeader) {
          maxWaitMs = Math.max(maxWaitMs, parseFloat(retryAfterHeader) * 1000);
        }
        
        // Groq specifies things like '7.66s' or '2m59.56s'
        const parseGroqTime = (str) => {
          if (!str) return 0;
          let ms = 0;
          const minMatch = str.match(/(\d+)m/);
          if (minMatch) ms += parseInt(minMatch[1]) * 60000;
          const secMatch = str.match(/(\d+\.?\d*)s/);
          if (secMatch) ms += parseFloat(secMatch[1]) * 1000;
          return ms;
        };

        maxWaitMs = Math.max(maxWaitMs, parseGroqTime(resetTokensHeader));
        maxWaitMs = Math.max(maxWaitMs, parseGroqTime(resetRequestsHeader));
        
        if (maxWaitMs > 0) retryAfter = maxWaitMs;
      }

      const body = await res.text().catch(() => '');
      const err = new Error(`OpenAI-compat HTTP ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      if (retryAfter) err.retryAfter = retryAfter;
      throw err;
    }

    if (onStream) {
      let fullText = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        const textChunk = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        const lines = textChunk.split('\n').filter(Boolean);
        for (const line of lines) {
          if (line.trim() === 'data: [DONE]') continue;
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              const delta = data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content;
              if (delta) {
                fullText += delta;
                onStream(trimDescription(fullText));
              }
            } catch (e) {}
          }
        }
      }
      return trimDescription(fullText);
    } else {
      const json = await res.json();
      const content = json && json.choices && json.choices[0] && json.choices[0].message
        ? json.choices[0].message.content
        : '';
      return trimDescription(content);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} cfg
 * @param {string} [cfg.base_url]      default https://api.openai.com/v1
 * @param {string} [cfg.api_key_env]   default OPENAI_API_KEY (set to '' to skip auth)
 * @param {string} [cfg.model]         default gpt-4o-mini
 * @param {number} [cfg.timeout_ms]    default 60000
 * @param {number} [cfg.temperature]   default 0.2
 * @param {object} [cfg.headers]       extra headers (e.g. for OpenRouter referer)
 */
function createOpenAIProvider(cfg = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available — Node 18+ is required');
  }
  const baseUrl = cfg.base_url || DEFAULT_BASE_URL;
  const model = cfg.model || DEFAULT_MODEL;
  const apiKeyEnv = cfg.api_key_env == null ? DEFAULT_API_KEY_ENV : cfg.api_key_env;
  const apiKey = apiKeyEnv ? getSecret(apiKeyEnv) : '';
  if (apiKeyEnv && !apiKey) {
    const err = new Error(
      `OpenAI-compatible provider needs the ${apiKeyEnv} environment variable. ` +
        'Set it in your shell, in a .env file, or run `reporose config --secret set ' +
        `${apiKeyEnv} <key>` +
        ' to store it securely.',
    );
    err.code = 'OPENAI_KEY_MISSING';
    throw err;
  }

  const timeoutMs = cfg.timeout_ms || 60_000;
  const temperature = cfg.temperature == null ? 0.2 : cfg.temperature;
  const contextSize = cfg.context_size || null; // For providers with limited context like Groq
  
  // TPM rate limiting for Groq (6000 TPM default, but configurable)
  // Higher TPM models (like groq/compound: 70000) can set this via config
  const maxTpm = cfg.max_tpm || 6000;
  const minDelayMs = cfg.min_delay_ms || Math.max(500, (60_000 / (maxTpm / 1000)) * 1.5); // ~1.5s for 6k TPM
  let lastRequestTime = 0;
  
  async function rateLimitedChat(args) {
    const now = Date.now();
    const timeSinceLast = now - lastRequestTime;
    if (timeSinceLast < minDelayMs) {
      await new Promise(r => setTimeout(r, minDelayMs - timeSinceLast));
    }
    lastRequestTime = Date.now();
    return chatComplete(args);
  }
  
  const fileSystem = 'You are a code analysis assistant. Write one compact paragraph of 4-6 sentences that explains what the file actually does, including behavior, workflow, state/effects, external interactions, and how it fits into the codebase. No markdown, no preamble.';
  const fnSystem = 'You are a code analysis assistant. Reply with exactly 1-2 short sentences describing what the function does. No markdown, no preamble.';
  const fullFileSystem = 'You are a code analysis assistant analyzing complete source code. Write one compact technical paragraph of 5-8 sentences that explains what the file actually does, which workflows or UI/backend behaviors it implements, important state/effects/API/auth/search/form logic, and how it fits into the codebase. No markdown, no preamble.';

  return {
    name: cfg.name || 'openai',
    model,
    contextSize, // Exposed for chunking decisions in summarizer
    async summarizeFile(input, onStream) {
      return rateLimitedChat({
        baseUrl, apiKey, model, prompt: renderFilePrompt(input),
        system: fileSystem, maxTokens: 200, temperature, timeoutMs,
        headers: cfg.headers, onStream,
      });
    },
    async summarizeFullFile(input, onStream) {
      // For full file summarization, the prompt is pre-built by renderFullFilePrompt
      // We use a higher token limit since we want more comprehensive descriptions
      const maxTokens = input.isLastChunk ? 2500 : 800;
      return rateLimitedChat({
        baseUrl, apiKey, model, prompt: input.prompt,
        system: fullFileSystem, maxTokens, temperature, timeoutMs,
        headers: cfg.headers, onStream,
      });
    },
    async summarizeFunction(input, onStream) {
      return rateLimitedChat({
        baseUrl, apiKey, model, prompt: renderFunctionPrompt(input),
        system: fnSystem, maxTokens: 120, temperature, timeoutMs,
        headers: cfg.headers, onStream,
      });
    },
    async close() {},
  };
}

module.exports = {
  createOpenAIProvider,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_API_KEY_ENV,
};
