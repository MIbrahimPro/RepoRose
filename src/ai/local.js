'use strict';

// local AI provider — uses node-llama-cpp to run .gguf models locally
// this is the "bring your own model" option

// node-llama-cpp is an optional dependency — if not installed, falls back to heuristic
// you need to download a .gguf model file and point config at it

const fs = require('fs');
const { renderFilePrompt, renderFunctionPrompt } = require('./prompts');

// three tiers with different resource requirements
// low = weak laptop, high = gaming rig with GPU
const TIERS = Object.freeze({
  low: {
    contextSize: 2048,
    gpuLayers: 0,
    fileTokens: 180,
    fnTokens: 90,
    fileSystem:
      'You are a code analysis assistant. Reply with one compact paragraph of 3-4 sentences describing what the file does. No markdown, no preamble.',
    fnSystem:
      'Reply with 1 short sentence describing what the function does. No markdown.',
  },
  medium: {
    contextSize: 4096,
    gpuLayers: 24,
    fileTokens: 280,
    fnTokens: 110,
    fileSystem:
      'You are a code analysis assistant. Write one compact paragraph of 4-6 sentences explaining what the file does, including workflow, state/effects, and external interactions. No markdown, no preamble.',
    fnSystem:
      'Reply with 1-2 short sentences describing what the function does. No markdown, no preamble.',
  },
  high: {
    contextSize: 8192,
    gpuLayers: 99,
    fileTokens: 480,
    fnTokens: 140,
    fileSystem:
      'You are a code analysis assistant analyzing complete source code. Write one compact technical paragraph of 5-8 sentences explaining what the file actually does, which workflows / UI / backend behaviors it implements, important state/effects/API/auth/search/form logic, and how it fits into the codebase. No markdown, no preamble.',
    fnSystem:
      'Reply with 1-2 specific sentences describing what the function does, including any noteworthy state, side effects, or call-graph hints. No markdown, no preamble.',
  },
});

// gets the tier config by name, defaults to low if unknown
function resolveTier(cfg) {
  const name = String(cfg.tier || 'low').toLowerCase();
  return TIERS[name] || TIERS.low;
}

// cleans up whitespace in AI responses
function trimDescription(text) {
  if (!text) return '';
  return String(text).replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
}

// dynamically imports node-llama-cpp
// uses new Function to handle ESM-only package from CommonJS
async function loadLlama() {
  try {
    // eslint-disable-next-line no-new-func
    const dynImport = new Function('p', 'return import(p)');
    return await dynImport('node-llama-cpp');
  } catch (err) {
    const e = new Error(
      'node-llama-cpp is not installed. Install it with `npm install node-llama-cpp` ' +
        'and configure a GGUF model with `reporose config --model-path /path/to/model.gguf`.',
    );
    e.cause = err;
    throw e;
  }
}

// creates the local provider
// loads the model, sets up chat sessions
async function createLocalProvider(cfg = {}) {
  if (!cfg.model_path) {
    throw new Error(
      'Local provider requires a model_path. Run: reporose config --model-path /path/to/model.gguf',
    );
  }
  if (!fs.existsSync(cfg.model_path)) {
    throw new Error(`Model file not found at ${cfg.model_path}`);
  }

  const tier = resolveTier(cfg);
  // Explicit fields win over tier presets.
  const contextSize = cfg.context_size || tier.contextSize;
  const gpuLayers = cfg.gpu_layers != null ? cfg.gpu_layers : tier.gpuLayers;

  const llama = await loadLlama();
  const llamaInstance = await llama.getLlama();
  const model = await llamaInstance.loadModel({
    modelPath: cfg.model_path,
    gpuLayers,
  });
  const context = await model.createContext({ contextSize });

  async function complete(systemPrompt, userPrompt, maxTokens) {
    const session = new llama.LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt,
    });
    try {
      const response = await session.prompt(userPrompt, {
        maxTokens,
        temperature: 0.2,
      });
      return trimDescription(response);
    } finally {
      if (typeof session.dispose === 'function') {
        await session.dispose();
      }
    }
  }

  return {
    name: 'local',
    model: cfg.model_path,
    contextSize,
    tier: cfg.tier || 'low',
    async summarizeFile(input) {
      return complete(tier.fileSystem, renderFilePrompt(input), tier.fileTokens);
    },
    async summarizeFunction(input) {
      return complete(tier.fnSystem, renderFunctionPrompt(input), tier.fnTokens);
    },
    async close() {
      try {
        if (typeof context.dispose === 'function') await context.dispose();
        if (typeof model.dispose === 'function') await model.dispose();
      } catch (_) {
        // Best-effort cleanup.
      }
    },
  };
}

module.exports = {
  createLocalProvider,
  TIERS,
  resolveTier,
};
