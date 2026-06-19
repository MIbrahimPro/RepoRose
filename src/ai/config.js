'use strict';

// config management — handles loading/saving .reporose/config.json
// and the global user config at ~/.reporose/config.json

// config shape is kinda complex cuz each provider has different options
// ollama needs num_ctx and stuff, cloud providers need api_key_env, etc

const fs = require('fs');
const os = require('os');
const path = require('path');

// default config — openrouter with a free model cuz thats the easiest to start with
// all the other provider configs are here too with sensible defaults
const DEFAULT_CONFIG = Object.freeze({
  ai: {
    provider: 'openrouter',
    model: 'meta-llama/llama-3.2-3b-instruct:free',
    ollama: {
      base_url: 'http://localhost:11434',
      model: 'qwen2.5-coder:7b',
      options: {
        num_ctx: 8192,
        temperature: 0,
        num_predict: 512,
      },
      timeout_ms: 600_000,
      // concurrency: 'auto' computes a sensible value from free RAM; an
      // integer caps the worker pool. 1 disables parallelism.
      concurrency: 'auto',
    },
    openai: {
      base_url: 'https://api.openai.com/v1',
      api_key_env: 'OPENAI_API_KEY',
      model: 'gpt-4o-mini',
      timeout_ms: 60_000,
      temperature: 0.2,
    },
    openrouter: {
      base_url: 'https://openrouter.ai/api/v1',
      api_key_env: 'OPENROUTER_API_KEY',
      model: 'meta-llama/llama-3.2-3b-instruct:free',
    },
    anthropic: {
      base_url: 'https://api.anthropic.com/v1',
      api_key_env: 'ANTHROPIC_API_KEY',
      // Haiku 4.5: cheapest in the lineup, plenty of headroom for summaries.
      model: 'claude-haiku-4-5',
      timeout_ms: 60_000,
      temperature: 0.2,
    },
    'ollama-cloud': {
      // Ollama's hosted service speaks the same /api/chat protocol as a
      // local daemon, but at https://ollama.com with bearer auth.
      base_url: 'https://ollama.com',
      api_key_env: 'OLLAMA_API_KEY',
      // 20B is the smallest cloud model — fast, generous rate limits, and
      // produces solid code summaries. Bigger options: gpt-oss:120b-cloud,
      // qwen3-coder:480b-cloud, deepseek-v3.1:671b-cloud.
      model: 'gpt-oss:20b-cloud',
      options: {
        num_ctx: 32_000,   // Cloud KV cache is generous; lean into it.
        temperature: 0,
        num_predict: 800,
      },
      timeout_ms: 120_000,
      concurrency: 'auto',
    },
    groq: {
      base_url: 'https://api.groq.com/openai/v1',
      api_key_env: 'GROQ_API_KEY',
      model: 'llama-3.1-8b-instant',
      timeout_ms: 30_000,
      context_size: 8192, // 8K context for llama-3.1-8b-instant
      // Rate limits (see https://console.groq.com/settings/limits)
      // llama-3.1-8b-instant: 6K TPM / 14.4K RPD / 30 RPM
      // groq/compound-mini: 70K TPM / 250 RPD / 30 RPM  <-- higher TPM, fewer daily requests
      max_tpm: 6000,
      // min_delay_ms: 1500, // Optional: override automatic delay calculation
    },
    local: {
      model_path: null,
      // 'tier' picks sensible defaults for context_size, gpu_layers, and
      // prompt richness. Override individual fields below if needed.
      tier: 'low', // 'low' | 'medium' | 'high'
      context_size: 2048,
      gpu_layers: 0,
    },
  },
});

// shortcuts so you can type --model cloud instead of --model openrouter
// or --model fast instead of --model groq
const PROVIDER_ALIASES = {
  cloud: 'openrouter',
  offline: 'heuristic',
  off: 'none',
  skip: 'none',
  ai: 'ollama', // common shorthand
  fast: 'groq', // Groq is known for speed
  claude: 'anthropic',
  'ollama-online': 'ollama-cloud',
  ollamacloud: 'ollama-cloud',
};
// the full list of providers we know about
const KNOWN_PROVIDERS = new Set([
  'heuristic', 'none', 'ollama', 'ollama-cloud', 'openai', 'openrouter',
  'anthropic', 'groq', 'local',
]);

// deep clone using JSON — not the fastest but works for config objects
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// merges two objects recursively
// used to apply user config on top of defaults
function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (typeof override !== 'object' || Array.isArray(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// returns the path to repo config file
function configPath(repoPath, outDir) {
  return path.resolve(repoPath, outDir || '.reporose', 'config.json');
}

// returns the path to global user config (~/.reporose/config.json)
function userConfigPath() {
  return path.join(os.homedir(), '.reporose', 'config.json');
}

// loads the global user config, falls back to defaults if missing
function loadUserConfig() {
  const file = userConfigPath();
  if (!fs.existsSync(file)) return deepClone(DEFAULT_CONFIG);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return deepMerge(deepClone(DEFAULT_CONFIG), raw);
  } catch (_e) {
    return deepClone(DEFAULT_CONFIG);
  }
}

// saves the global user config
function saveUserConfig(cfg) {
  const file = userConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return file;
}

// loads config for a repo
// priority: defaults < user config < repo config
function loadConfig(repoPath, outDir) {
  // Start with default config
  let cfg = deepClone(DEFAULT_CONFIG);

  // Merge user config if it exists (as fallback before repo config)
  const userCfg = loadUserConfig();
  if (userCfg && userCfg.ai) {
    cfg = deepMerge(cfg, userCfg);
  }

  // Merge repo config if it exists (takes highest priority)
  const file = configPath(repoPath, outDir);
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      cfg = deepMerge(cfg, raw);
    } catch (_e) {
      // Ignore malformed repo config, use what we have
    }
  }

  return cfg;
}

// saves repo config to .reporose/config.json
function saveConfig(repoPath, cfg, outDir) {
  const file = configPath(repoPath, outDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return file;
}
















/* ------------------------------------------------------------------ */
/* Preset store (~/.reporose/presets.json)                              */
/* ------------------------------------------------------------------ */
// presets let you save configs like "my-ollama-setup" and reuse them

// path to the presets file
function presetsPath() {
  return path.join(os.homedir(), '.reporose', 'presets.json');
}

// loads all saved presets
function loadPresets() {
  const file = presetsPath();
  if (!fs.existsSync(file)) return { presets: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.presets) return { presets: {} };
    return raw;
  } catch (_e) {
    return { presets: {} };
  }
}

// saves the presets file
function savePresets(store) {
  const file = presetsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2) + '\n');
  return file;
}

// lists all preset names with their provider and model
function listPresets() {
  const store = loadPresets();
  return Object.entries(store.presets).map(([name, cfg]) => ({
    name,
    provider: (cfg && cfg.ai && cfg.ai.provider) || 'unknown',
    model: presetModelLabel(cfg),
  }));
}

// gets a human-readable label for a preset (like "qwen2.5-coder:7b")
function presetModelLabel(cfg) {
  const ai = (cfg && cfg.ai) || {};
  const p = ai.provider;
  if (p === 'ollama')         return ai.ollama && ai.ollama.model;
  if (p === 'ollama-cloud')   return ai['ollama-cloud'] && ai['ollama-cloud'].model;
  if (p === 'openai')         return ai.openai && ai.openai.model;
  if (p === 'openrouter')     return ai.openrouter && ai.openrouter.model;
  if (p === 'anthropic')      return ai.anthropic && ai.anthropic.model;
  if (p === 'groq')           return ai.groq && ai.groq.model;
  if (p === 'local')          return (ai.local && ai.local.model_path) || (ai.local && ai.local.tier);
  if (p === 'heuristic')      return 'rule-based';
  if (p === 'none')           return 'no descriptions';
  return ai.model || '';
}

// saves current config as a named preset
function savePreset(name, cfg) {
  if (!name || !/^[a-z0-9._-]+$/i.test(name)) {
    throw new Error('Preset name must be alphanumeric (a-z, 0-9, . , _ , -).');
  }
  const store = loadPresets();
  store.presets[name] = deepClone(cfg);
  savePresets(store);
  return name;
}

// deletes a preset by name
function deletePreset(name) {
  const store = loadPresets();
  if (!store.presets[name]) return false;
  delete store.presets[name];
  savePresets(store);
  return true;
}

// loads a preset and merges with defaults
function loadPreset(name) {
  const store = loadPresets();
  if (!store.presets[name]) {
    throw new Error(`Preset "${name}" not found. Run \`reporose preset list\`.`);
  }
  return deepMerge(deepClone(DEFAULT_CONFIG), store.presets[name]);
}

// applies a preset to a config
// keeps everything else but overwrites the AI section
function applyPreset(cfg, name) {
  const preset = loadPreset(name);
  return deepMerge(deepClone(cfg), { ai: preset.ai });
}

// handles --model flag
// can be provider name, alias, or actual model name
function applyModelFlag(cfg, value) {
  const next = deepClone(cfg);
  next.ai = next.ai || {};
  const lower = String(value || '').toLowerCase();
  const resolved = PROVIDER_ALIASES[lower] || lower;
  if (KNOWN_PROVIDERS.has(resolved)) {
    next.ai.provider = resolved;
  } else {
    next.ai.model = value;
  }
  return next;
}

// sets the local model path (for .gguf files)
function applyModelPath(cfg, modelPath) {
  const next = deepClone(cfg);
  next.ai = next.ai || {};
  next.ai.local = next.ai.local || {};
  next.ai.local.model_path = modelPath;
  return next;
}

// sets the local provider tier (low/medium/high)
// each tier has different context/gpu defaults
function applyLocalTier(cfg, tier) {
  const next = deepClone(cfg);
  next.ai = next.ai || {};
  next.ai.local = next.ai.local || {};
  const lower = String(tier || '').toLowerCase();
  const valid = ['low', 'medium', 'high'];
  if (!valid.includes(lower)) {
    throw new Error(`Invalid local tier "${tier}". Choose one of: ${valid.join(', ')}`);
  }
  next.ai.local.tier = lower;
  return next;
}

// sets which env var holds the API key (like OPENAI_API_KEY)
function applyApiKeyEnv(cfg, envName) {
  const next = deepClone(cfg);
  next.ai = next.ai || {};
  const provider = next.ai.provider;
  const cloudProviders = new Set([
    'openai', 'openrouter', 'anthropic', 'groq', 'ollama-cloud',
  ]);
  if (cloudProviders.has(provider)) {
    next.ai[provider] = next.ai[provider] || {};
    next.ai[provider].api_key_env = envName;
  } else {
    // default to OpenRouter for back-compat
    next.ai.openrouter = next.ai.openrouter || {};
    next.ai.openrouter.api_key_env = envName;
  }
  return next;
}

// sets custom base URL for the provider
function applyBaseUrl(cfg, url) {
  const next = deepClone(cfg);
  next.ai = next.ai || {};
  const provider = next.ai.provider;
  const urlProviders = new Set([
    'ollama', 'ollama-cloud', 'openai', 'openrouter', 'anthropic', 'groq',
  ]);
  if (urlProviders.has(provider)) {
    next.ai[provider] = next.ai[provider] || {};
    next.ai[provider].base_url = url;
  }
  return next;
}

// sets the model name for the active provider
function applyModelName(cfg, modelName) {
  const next = deepClone(cfg);
  next.ai = next.ai || {};
  const provider = next.ai.provider;
  const modelProviders = new Set([
    'ollama', 'ollama-cloud', 'openai', 'openrouter', 'anthropic', 'groq', 'local',
  ]);
  if (modelProviders.has(provider)) {
    next.ai[provider] = next.ai[provider] || {};
    next.ai[provider].model = modelName;
  } else {
    next.ai.model = modelName;
  }
  return next;
}

// sets ollama-specific options like num_ctx or temperature
function applyOllamaOption(cfg, key, value) {
  const next = deepClone(cfg);
  next.ai = next.ai || {};
  const provider = next.ai.provider === 'ollama-cloud' ? 'ollama-cloud' : 'ollama';
  next.ai[provider] = next.ai[provider] || {};
  next.ai[provider].options = next.ai[provider].options || {};
  next.ai[provider].options[key] = value;
  return next;
}

// sets how many concurrent requests to make
function applyConcurrency(cfg, value) {
  const next = deepClone(cfg);
  next.ai = next.ai || {};
  const provider = next.ai.provider;
  const concurrentProviders = new Set([
    'ollama', 'ollama-cloud', 'local', 'openai', 'openrouter', 'anthropic', 'groq',
  ]);
  if (concurrentProviders.has(provider)) {
    next.ai[provider] = next.ai[provider] || {};
    if (value === 'auto' || value == null) next.ai[provider].concurrency = 'auto';
    else next.ai[provider].concurrency = Math.max(1, Math.floor(Number(value)));
  }
  return next;
}

module.exports = {
  DEFAULT_CONFIG,
  PROVIDER_ALIASES,
  KNOWN_PROVIDERS,
  configPath,
  userConfigPath,
  loadConfig,
  loadUserConfig,
  saveConfig,
  saveUserConfig,
  applyModelFlag,
  applyModelPath,
  applyLocalTier,
  applyApiKeyEnv,
  applyBaseUrl,
  applyModelName,
  applyOllamaOption,
  applyConcurrency,
  // Presets
  presetsPath,
  loadPresets,
  savePresets,
  listPresets,
  loadPreset,
  savePreset,
  deletePreset,
  applyPreset,
  presetModelLabel,
};
