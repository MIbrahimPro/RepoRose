'use strict';

const { createOpenAIProvider } = require('./openai');

/**
 * OpenRouter provider — thin wrapper around the generic OpenAI-compatible
 * provider, pre-configured with OpenRouter's base URL and recommended headers.
 *
 * Required environment: OPENROUTER_API_KEY (or whatever key name is configured).
 */

const DEFAULT_MODEL = 'meta-llama/llama-3.2-3b-instruct:free';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_API_KEY_ENV = 'OPENROUTER_API_KEY';

function createOpenRouterProvider(cfg = {}) {
  const provider = createOpenAIProvider({
    name: 'openrouter',
    base_url: cfg.base_url || DEFAULT_BASE_URL,
    api_key_env: cfg.api_key_env || DEFAULT_API_KEY_ENV,
    model: cfg.model || DEFAULT_MODEL,
    timeout_ms: cfg.timeout_ms || 30_000,
    temperature: cfg.temperature == null ? 0.2 : cfg.temperature,
    headers: {
      'HTTP-Referer': 'https://github.com/reporose/reporose',
      'X-Title': 'RepoRose',
    },
  });
  return provider;
}

module.exports = {
  createOpenRouterProvider,
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  DEFAULT_API_KEY_ENV,
};
