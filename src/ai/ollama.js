'use strict';

// ollama provider — talks to local ollama or ollama cloud
// uses the /api/chat endpoint which is native to ollama

const { renderFilePrompt, renderFunctionPrompt } = require('./prompts');
const { getSecret } = require('../utils/secrets');

// defaults for local ollama
const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen2.5-coder:7b';

// 8K context is enough for most files and wont eat all your RAM
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OPTIONS = Object.freeze({
  num_ctx: 8192,
  temperature: 0,
  num_predict: 512,
});

// cleans up whitespace from AI responses
function trimDescription(text) {
  // if no text is provided, return an empty string
  if (!text) return '';
  // remove leading and trailing whitespace, and replace multiple spaces with a single space
  return String(text).replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
}

// removes <thinking> blocks from reasoning models
// also strips common prefixes like "Answer:" or "Description:"
function postProcess(raw) {
  // if no text is provided, return an empty string
  if (!raw) return '';
  let text = String(raw);
  // remove <think> blocks
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // remove common prefixes
  text = text.replace(/^[\s\n]*(?:answer|description|summary)\s*:\s*/i, '');
  // trim the text to remove any remaining whitespace
  return trimDescription(text);
}

// sends a chat request to ollama
// handles both streaming and non-streaming responses
async function chat({ baseUrl, apiKey, model, prompt, system, options, timeoutMs, signal, onStream }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/api/chat`;
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort());

  // Cloud-hosted Ollama (https://ollama.com) requires bearer auth; the same
  // wire protocol works for both local and cloud, only the headers differ.
  const reqHeaders = { 'Content-Type': 'application/json' };
  if (apiKey) reqHeaders.Authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify({
        model,
        messages,
        stream: !!onStream,
        keep_alive: -1,
        options: { ...DEFAULT_OPTIONS, ...(options || {}) },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status}: ${errText}`);
    }

    if (onStream) {
      let fullText = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        const textChunk = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        const lines = textChunk.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            if (data.message && data.message.content) {
              fullText += data.message.content;
              onStream(postProcess(fullText));
            }
          } catch (e) {}
        }
      }
      return postProcess(fullText);
    } else {
      const data = await res.json();
      const content = data && data.message && data.message.content;
      return postProcess(content);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// checks if ollama server is reachable
// uses /api/tags endpoint
async function ping(baseUrl, timeoutMs = 3000, apiKey = '') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/api/tags`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return { ok: true, models: (data && data.models) || [] };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

// creates the ollama provider
// works for both local and cloud (cloud needs api_key_env)
async function createOllamaProvider(cfg = {}) {
  const baseUrl = cfg.base_url || DEFAULT_BASE_URL;
  const model = cfg.model || DEFAULT_MODEL;
  const providerName = cfg.name || 'ollama';

  // Optional bearer auth: only resolve when an env var is configured. Local
  // installs leave this blank; cloud installs (ollama-cloud) point at
  // OLLAMA_API_KEY.
  let apiKey = '';
  if (cfg.api_key_env) {
    apiKey = getSecret(cfg.api_key_env) || '';
    if (!apiKey) {
      const err = new Error(
        `${providerName} provider needs the ${cfg.api_key_env} environment variable. ` +
          'Set it in your shell, in a .env file, or run `reporose config --secret set ' +
          `${cfg.api_key_env} <key>` +
          ' to store it securely.',
      );
      err.code = 'OLLAMA_KEY_MISSING';
      throw err;
    }
  }

  const options = {
    num_ctx: 8192, // Default to a moderate context — fast on iGPU/CPU
    temperature: 0,
    num_predict: 512,
    ...(cfg.options || {}),
  };
  const timeoutMs = cfg.timeout_ms || DEFAULT_TIMEOUT_MS;

  // Reachability check up front so we fail fast if Ollama isn't running.
  const pingResult = await ping(baseUrl, 5000, apiKey);
  if (!pingResult.ok) {
    const hint = apiKey
      ? `Check that ${cfg.api_key_env} is valid and that ${baseUrl} is reachable.`
      : 'Start it with `ollama serve` or set --ollama-url.';
    const err = new Error(
      `Cannot reach ${providerName} at ${baseUrl}: ${pingResult.error || 'HTTP ' + pingResult.status}. ` + hint,
    );
    err.code = 'OLLAMA_UNREACHABLE';
    throw err;
  }

  // The cloud /api/tags response doesn't always list every available model
  // (it returns the user's pulled/recent ones). Skip the membership check
  // for cloud installs and let the actual /api/chat call surface a 404 if
  // the model name is wrong. For local daemons we still validate, since a
  // typo there is a common usability footgun.
  const isCloud = !!apiKey || /ollama\.com/i.test(baseUrl);
  if (!isCloud) {
    const have = (pingResult.models || []).some((m) => m.name === model || m.model === model);
    if (!have) {
      const available = (pingResult.models || []).map((m) => m.name).slice(0, 8);
      const err = new Error(
        `Ollama model "${model}" not found at ${baseUrl}. ` +
          `Pull it first: \`ollama pull ${model}\`. ` +
          (available.length ? `Available: ${available.join(', ')}` : 'No models installed.'),
      );
      err.code = 'OLLAMA_MODEL_MISSING';
      throw err;
    }
  }

  // Maximum prompt size derived from num_ctx. Reserve `num_predict` tokens for
  // the reply and approximate 1 token ≈ 4 chars. The prompt is truncated past
  // this limit so very large files don't blow the context window.
  const maxPromptChars = Math.max(
    1000,
    ((options.num_ctx || DEFAULT_OPTIONS.num_ctx) - (options.num_predict || 0)) * 4,
  );
  function truncate(prompt) {
    if (!prompt) return '';
    if (prompt.length <= maxPromptChars) return prompt;
    const head = prompt.slice(0, Math.floor(maxPromptChars * 0.7));
    const tail = prompt.slice(-Math.floor(maxPromptChars * 0.25));
    return `${head}\n... [truncated ${prompt.length - head.length - tail.length} chars] ...\n${tail}`;
  }

  const fileSystem = 'You are a code analysis assistant. Write one compact paragraph of 4-6 sentences that explains what the file actually does, including workflow, state/effects, external interactions, and how it fits into the codebase. No markdown, no preamble, no quotes.';
  const fnSystem = 'You are a code analysis assistant. Reply with exactly 1-2 short sentences describing what the function does. No markdown, no preamble, no quotes.';
  const fullFileSystem = 'You are a code analysis assistant analyzing complete source code. Write one compact technical paragraph of 5-8 sentences that explains what the file actually does, which workflows or UI/backend behaviors it implements, important state/effects/API/auth/search/form logic, and how it fits into the codebase. No markdown, no preamble.';

  return {
    name: providerName,
    model,
    contextSize: options.num_ctx || 8192,
    async summarizeFile(input, onStream) {
      const prompt = truncate(renderFilePrompt(input));
      const fileOptions = { ...options, num_predict: Math.min(options.num_predict || 512, 400) };
      return chat({ baseUrl, apiKey, model, prompt, system: fileSystem, options: fileOptions, timeoutMs, onStream });
    },
    async summarizeFullFile(input, onStream) {
      const prompt = truncate(input.prompt);
      const adjustedOptions = input.isLastChunk
        ? { ...options, num_predict: Math.min(options.num_predict || 512, 400) }
        : { ...options, num_predict: Math.min(options.num_predict || 512, 200) };
      return chat({ baseUrl, apiKey, model, prompt, system: fullFileSystem, options: adjustedOptions, timeoutMs, onStream });
    },
    async summarizeFunction(input, onStream) {
      const prompt = truncate(renderFunctionPrompt(input));
      const fnOptions = { ...options, num_predict: Math.min(options.num_predict || 512, 120) };
      return chat({ baseUrl, apiKey, model, prompt, system: fnSystem, options: fnOptions, timeoutMs, onStream });
    },
    async close() {
      /* Explicitly disabled to preserve the daemon's keep_alive setting.
       * Forcing keep_alive: 0 here unloads the model and forces a slow
       * cold reload on the next run, even when the user has configured a
       * generous OLLAMA_KEEP_ALIVE / OLLAMA_NUM_PARALLEL on the daemon.
       * Let the daemon manage its own residency. */
    },
  };
}

// models available on ollama cloud
// sorted by size/cost (smallest first)
const CLOUD_MODELS = [
  { id: 'gpt-oss:20b-cloud', label: 'gpt-oss 20B', hint: 'small, fast, generous limits — recommended for summaries' },
  { id: 'gpt-oss:120b-cloud', label: 'gpt-oss 120B', hint: 'higher quality, ~6× the cost / time' },
  { id: 'qwen3-coder:480b-cloud', label: 'qwen3-coder 480B', hint: 'specialized for code; heavier' },
  { id: 'deepseek-v3.1:671b-cloud', label: 'DeepSeek v3.1 671B', hint: 'top quality; slow + expensive' },
  { id: 'kimi-k2:1t-cloud', label: 'Kimi K2 1T', hint: 'experimental; long context' },
];
const CLOUD_BASE_URL = 'https://ollama.com';
const CLOUD_API_KEY_ENV = 'OLLAMA_API_KEY';
const CLOUD_DEFAULT_MODEL = 'gpt-oss:20b-cloud';

module.exports = {
  createOllamaProvider,
  ping,
  postProcess,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  CLOUD_BASE_URL,
  CLOUD_API_KEY_ENV,
  CLOUD_DEFAULT_MODEL,
  CLOUD_MODELS,
  DEFAULT_OPTIONS: { num_ctx: 8192, temperature: 0, num_predict: 512 },
};
