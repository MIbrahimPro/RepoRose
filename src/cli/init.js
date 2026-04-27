'use strict';

/**
reporose init — the interactive setup wizard

asks you questions like:
- which AI provider?
- what model?
- api key?

then saves it all to .reporose/config.json

also handles installing ollama if you dont have it
and can run analyze immediately after if you want

uses fancy prompts in real terminals, boring text in CI
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const {
  loadConfig,
  saveConfig,
  applyModelFlag,
  applyOllamaOption,
  applyApiKeyEnv,
  applyModelName,
  applyBaseUrl,
  applyModelPath,
  applyLocalTier,
  applyConcurrency,
  savePreset,
} = require('../ai/config');
const {
  ping: pingOllama,
  DEFAULT_MODEL: DEFAULT_OLLAMA_MODEL,
  CLOUD_BASE_URL: OLLAMA_CLOUD_URL,
  CLOUD_API_KEY_ENV: OLLAMA_CLOUD_KEY,
  CLOUD_DEFAULT_MODEL: OLLAMA_CLOUD_MODEL,
  CLOUD_MODELS: OLLAMA_CLOUD_MODELS,
} = require('../ai/ollama');
const {
  RECOMMENDED_MODELS: ANTHROPIC_MODELS,
  DEFAULT_MODEL: ANTHROPIC_DEFAULT_MODEL,
  DEFAULT_API_KEY_ENV: ANTHROPIC_DEFAULT_KEY,
  DEFAULT_BASE_URL: ANTHROPIC_DEFAULT_URL,
} = require('../ai/anthropic');
const { TIERS: LOCAL_TIERS } = require('../ai/local');
const prompt = require('./prompt');
const { setSecret } = require('../utils/secrets');
const { isInstalled: isOllamaInstalled, installOllama } = require('./ollama-installer');
















/* ------------------------------------------------------------------ */
/* External tool detection                                             */
/* ------------------------------------------------------------------ */

// checks if a command exists on the system
// runs `which` cuz thats the unix way
function commandExists(cmd) {
  const result = spawnSync('which', [cmd], { stdio: 'ignore' });
  return result.status === 0;
}

// spawns a process and streams its output to the terminal
// used for `ollama pull` so you can see the download progress
function runStreaming(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      ...opts,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

// returns install instructions for the current platform
// cuz everyone needs different commands
function platformInstallHint() {
  const platform = os.platform();
  if (platform === 'darwin') {
    return 'macOS:   brew install ollama   (or download https://ollama.com/download)';
  }
  if (platform === 'linux') {
    return 'Linux:   curl -fsSL https://ollama.com/install.sh | sh';
  }
  if (platform === 'win32') {
    return 'Windows: download installer from https://ollama.com/download/windows';
  }
  return 'See https://ollama.com/download';
}
















/* ------------------------------------------------------------------ */
/* Per-provider wizard branches                                        */
/* ------------------------------------------------------------------ */

// each of these configures a specific AI provider
// theyre long cuz each provider needs different stuff

// configures local ollama — checks if installed, offers to install,
// picks model, sets options,,, its a whole thing
async function configureOllama(session, cfg) {
  // check if ollama binary exists
  if (!isOllamaInstalled()) {
    prompt.note('Ollama is not installed on this machine.');

    const installed = await installOllama({
      onLog: (msg) => prompt.note(msg),
    });

    if (!installed) {
      prompt.note('Please install Ollama manually from https://ollama.com');
      prompt.note('Then re-run `reporose init`.');
      return null;
    }

    // Give user a moment to start the daemon if needed
    prompt.note('Checking for Ollama daemon...');
  }

  // 2. Check the daemon
  const baseUrl = await prompt.text(session, {
    message: 'Ollama base URL',
    defaultValue: 'http://localhost:11434',
  });

  let pong = await pingOllama(baseUrl, 2000);
  if (!pong.ok) {
    prompt.note(`Cannot reach ${baseUrl}. The Ollama server is not running.`);
    prompt.note('Start it in another terminal: `ollama serve`');
    const wait = await prompt.confirm(session, { message: 'Wait and retry?', defaultYes: true });
    if (wait) {
      prompt.note('Retrying in 5 seconds...');
      await new Promise((r) => setTimeout(r, 5000));
      pong = await pingOllama(baseUrl, 3000);
    }
    if (!pong.ok) {
      prompt.note('Still cannot reach Ollama. Aborting Ollama setup.');
      return null;
    }
  }

  // 3. Pick a model
  const installed = (pong.models || []).map((m) => m.name || m.model).filter(Boolean);
  const recommended = DEFAULT_OLLAMA_MODEL;
  prompt.note(`Installed models: ${installed.length ? installed.join(', ') : '(none)'}`);
  prompt.note(`Recommended (fast, runs on iGPU/CPU): ${recommended}  (~400 MB)`);
  const model = await prompt.text(session, {
    message: 'Model name',
    defaultValue: installed[0] || recommended,
  });

  // 4. Pull if missing
  const haveIt = installed.some((m) => m === model);
  if (!haveIt) {
    const pull = await prompt.confirm(session, {
      message: `Model "${model}" is not installed. Pull it now?`,
      defaultYes: true,
    });
    if (pull) {
      try {
        prompt.note(`Running: ollama pull ${model}`);
        await runStreaming('ollama', ['pull', model]);
      } catch (err) {
        prompt.note(`Pull failed: ${err.message}`);
        return null;
      }
    } else {
      prompt.note('Skipping pull. You can pull later with `ollama pull <model>`.');
    }
  }

  // 5. Tunable options
  prompt.note('Defaults: num_ctx=8192, temperature=0, num_predict=512, concurrency=auto');
  prompt.note('(Lower context = faster on iGPU/CPU; concurrency=auto picks workers from free RAM.)');
  const tweak = await prompt.confirm(session, { message: 'Use the defaults?', defaultYes: true });

  let numCtx = 8192;
  let temperature = 0;
  let numPredict = 512;
  let concurrency = 'auto';
  if (!tweak) {
    numCtx = Number(await prompt.text(session, { message: 'num_ctx (context window)', defaultValue: '8192' })) || 8192;
    temperature = Number(await prompt.text(session, { message: 'temperature (0 = deterministic)', defaultValue: '0' })) || 0;
    numPredict = Number(await prompt.text(session, { message: 'num_predict (max output tokens)', defaultValue: '512' })) || 512;
    const concRaw = (await prompt.text(session, { message: 'concurrency (number or "auto")', defaultValue: 'auto' })).trim();
    concurrency = concRaw === 'auto' || concRaw === '' ? 'auto' : Math.max(1, Math.floor(Number(concRaw))) || 'auto';
  }

  let next = applyModelFlag(cfg, 'ollama');
  next = applyBaseUrl(next, baseUrl);
  next = applyModelName(next, model);
  next = applyOllamaOption(next, 'num_ctx', numCtx);
  next = applyOllamaOption(next, 'temperature', temperature);
  next = applyOllamaOption(next, 'num_predict', numPredict);
  next = applyConcurrency(next, concurrency);
  return next;
}

// configures openai or openrouter — asks for api key, base url, model
// theyre similar enough that we handle both here
async function configureOpenAI(session, cfg, providerKey /* 'openai' | 'openrouter' */) {
  const defaults = {
    openai: {
      envName: 'OPENAI_API_KEY',
      baseUrl: 'https://api.openai.com/v1',
      modelName: 'gpt-4o-mini',
    },
    openrouter: {
      envName: 'OPENROUTER_API_KEY',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelName: 'meta-llama/llama-3.2-3b-instruct:free',
    },
  }[providerKey];

  const envName = await prompt.text(session, {
    message: 'Env var holding the API key',
    defaultValue: defaults.envName,
  });
  if (!process.env[envName]) {
    prompt.note(`${envName} is not set in the current shell.`);
    prompt.note(`Set it before running \`reporose analyze\`: export ${envName}=...`);
    prompt.note('(Or save it to .env at the project root — RepoRose loads that automatically.)');
  }

  const customUrl = await prompt.confirm(session, {
    message: `Use a custom base URL? (default ${defaults.baseUrl})`,
    defaultYes: false,
  });
  const baseUrl = customUrl
    ? await prompt.text(session, { message: 'Base URL', defaultValue: defaults.baseUrl })
    : defaults.baseUrl;
  const modelName = await prompt.text(session, {
    message: 'Model name',
    defaultValue: defaults.modelName,
  });

  let next = applyModelFlag(cfg, providerKey);
  next = applyBaseUrl(next, baseUrl);
  next = applyModelName(next, modelName);
  next = applyApiKeyEnv(next, envName);
  return next;
}

// configures local GGUF model — asks for tier (low/medium/high)
// then model path. tier sets sensible defaults for context/gpu layers
async function configureLocal(session, cfg) {
  const tier = await prompt.select(session, {
    message: 'How much horsepower does this PC have?',
    options: [
      {
        value: 'low',
        label: 'Low end',
        hint: `4 GB RAM, no GPU — ctx ${LOCAL_TIERS.low.contextSize}, ${LOCAL_TIERS.low.gpuLayers} GPU layers (~1B-3B GGUF)`,
      },
      {
        value: 'medium',
        label: 'Medium',
        hint: `8-16 GB, integrated GPU — ctx ${LOCAL_TIERS.medium.contextSize}, ${LOCAL_TIERS.medium.gpuLayers} GPU layers (~7B GGUF)`,
      },
      {
        value: 'high',
        label: 'High end',
        hint: `16+ GB, dedicated GPU — ctx ${LOCAL_TIERS.high.contextSize}, ${LOCAL_TIERS.high.gpuLayers} GPU layers (~13B+ GGUF)`,
      },
    ],
  });

  const modelPath = await prompt.text(session, {
    message: 'Path to .gguf model file',
    defaultValue: '',
  });
  if (!modelPath) {
    prompt.note('No path provided; aborting local setup.');
    return null;
  }
  if (!fs.existsSync(modelPath)) {
    prompt.note(`Warning: ${modelPath} does not exist yet. Saving config anyway.`);
  }
  let next = applyModelFlag(cfg, 'local');
  next = applyLocalTier(next, tier);
  next = applyModelPath(next, path.resolve(modelPath));
  return next;
}

// configures anthropic claude — defaults to haiku-4-5 cuz its cheap
// but you can pick any model they offer
async function configureAnthropic(session, cfg) {
  // Anthropic Claude setup - we're going for a more affordable option here
  prompt.note('Anthropic Claude (Messages API). Default model is Haiku 4.5 — cheapest, fastest, ample for summaries.');

  const modelChoice = await prompt.select(session, {
    message: 'Which Claude model?',
    options: [
      ...ANTHROPIC_MODELS.map((m) => ({ value: m.id, label: m.label, hint: m.hint })),
      { value: '__custom__', label: 'Type a custom model id', hint: 'any value accepted by /v1/messages' },
    ],
  });
  const modelName = modelChoice === '__custom__'
    ? await prompt.text(session, {
        message: 'Custom Anthropic model id',
        defaultValue: ANTHROPIC_DEFAULT_MODEL,
      })
    : modelChoice;

  const envName = await prompt.text(session, {
    message: 'Env var holding the Anthropic API key',
    defaultValue: ANTHROPIC_DEFAULT_KEY,
  });
  if (!process.env[envName]) {
    prompt.note(`${envName} is not set in the current shell.`);
    prompt.note(`Set it before running \`reporose analyze\`: export ${envName}=...`);
    prompt.note('(Or save it to a .env file at the project root — RepoRose loads that automatically.)');
  }

  let next = applyModelFlag(cfg, 'anthropic');
  next = applyBaseUrl(next, ANTHROPIC_DEFAULT_URL);
  next = applyModelName(next, modelName);
  next = applyApiKeyEnv(next, envName);
  return next;
}

// configures ollama cloud — like local ollama but hosted
// has a fancy (I tried making it fancy,, but then I got tired and this slop was produced by AI,,, dont ask,, it also had emojis) ascii box with setup instructions
async function configureOllamaCloud(session, cfg) {
  // OSC-8 hyperlink support: https://gist.github.com/egmontkob/eb114294efaac3d14bbb3e6f88b20831
  const hyperlink = (text, url) => `\x1B]8;;${url}\x1B\\${text}\x1B]8;;\x1B\\`;

  prompt.note('═══════════════════════════════════════════════════════════');
  prompt.note('    Ollama Cloud Setup');
  prompt.note('═══════════════════════════════════════════════════════════');
  prompt.note('');
  prompt.note('  Why Ollama Cloud?');
  prompt.note('   • Generous free tier (perfect for code summaries)');
  prompt.note('   • Fast inference (no waiting for model warm-up)');
  prompt.note('   • Great for teams (shareable API keys)');
  prompt.note('');
  prompt.note('  Follow these steps to get your API key:');
  prompt.note('');
  prompt.note('   1. Visit: ' + hyperlink('ollama.com/settings/keys', 'https://ollama.com/settings/keys'));
  prompt.note('      (Click the link or copy-paste the URL)');
  prompt.note('');
  prompt.note('   2. Sign up for a free account (or log in)');
  prompt.note('');
  prompt.note('   3. Click "Create API Key" and give it a name');
  prompt.note('      (e.g., "reporose-cli")');
  prompt.note('');
  prompt.note('   4. Copy the key (starts with "sk-")');
  prompt.note('');
  prompt.note('   5. Paste it below (Ctrl+V or Cmd+V works)');
  prompt.note('═══════════════════════════════════════════════════════════');

  const modelChoice = await prompt.select(session, {
    message: 'Which cloud model?',
    options: [
      ...OLLAMA_CLOUD_MODELS.map((m) => ({ value: m.id, label: m.label, hint: m.hint })),
      { value: '__custom__', label: 'Type a custom model id', hint: 'any "<name>:<tag>-cloud" model from ollama.com' },
    ],
  });
  const modelName = modelChoice === '__custom__'
    ? await prompt.text(session, {
        message: 'Custom Ollama Cloud model id',
        defaultValue: OLLAMA_CLOUD_MODEL,
      })
    : modelChoice;

  prompt.note('First requests may take 10-30s while the model warms up. Subsequent calls are fast.');

  const envName = await prompt.text(session, {
    message: 'Env var name for the API key',
    defaultValue: OLLAMA_CLOUD_KEY,
  });

  // Prompt for API key if not already set
  const existingKey = process.env[envName] || '';
  if (!existingKey) {
    const apiKey = await prompt.password(session, {
      message: `Paste your Ollama Cloud API key (or leave blank to set ${envName} later)`,
    });
    if (apiKey && apiKey.trim()) {
      setSecret(envName, apiKey.trim());
      prompt.note(`API key stored securely. You can manage it with: reporose config --secret`);
    } else {
      prompt.note(`No key provided. Set ${envName} before running: export ${envName}=...`);
    }
  } else {
    prompt.note(`Using existing ${envName} from environment.`);
  }

  // Cloud has plenty of context; default to a roomy 32K window.
  let next = applyModelFlag(cfg, 'ollama-cloud');
  next = applyBaseUrl(next, OLLAMA_CLOUD_URL);
  next = applyModelName(next, modelName);
  next = applyApiKeyEnv(next, envName);
  next = applyOllamaOption(next, 'num_ctx', 32_000);
  next = applyOllamaOption(next, 'temperature', 0);
  next = applyOllamaOption(next, 'num_predict', 800);
  return next;
}
















/* ------------------------------------------------------------------ */
/* Main wizard                                                         */
/* ------------------------------------------------------------------ */

// the actual init function — shows provider menu, calls the right config fn,
// saves config, optionally runs analyze

async function init(targetPath, options = {}) {
  const repoPath = path.resolve(targetPath || process.cwd());
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Path does not exist: ${repoPath}`);
  }

  const session = prompt.createSession();

  try {
    prompt.intro('RepoRose setup', repoPath);

    // provider selection menu
    // positions 1-6 are stable for tests (they pipe numeric choices)
    // new providers go at the end
    // ollama-cloud is default (index 7) cuz its the easiest
    const providerOptions = [
      { value: 'heuristic',    label: 'Rule-based (offline)',     hint: 'fast, no setup, decent quality' },
      { value: 'ollama',       label: 'Ollama (local AI)',        hint: 'free, runs on your machine' },
      { value: 'openai',       label: 'OpenAI / compatible',      hint: 'gpt-4o-mini etc., needs API key' },
      { value: 'openrouter',   label: 'OpenRouter',               hint: 'free + paid models, needs API key' },
      { value: 'local',        label: 'Local GGUF (advanced)',    hint: 'node-llama-cpp + your own .gguf' },
      { value: 'none',         label: 'No AI descriptions',       hint: 'just scan + dependency map' },
      { value: 'anthropic',    label: 'Anthropic Claude',         hint: 'Haiku 4.5 — cheap + great at summaries' },
      { value: 'ollama-cloud', label: 'Ollama Cloud ★',          hint: 'gpt-oss:20b-cloud — small + generous limits (recommended)' },
    ];
    const provider = await prompt.select(session, {
      message: 'Which AI provider should describe your code?',
      options: providerOptions,
      initial: 7, // Ollama Cloud is the default/recommended
    });

    let cfg = loadConfig(repoPath, options.outDir);

    // call the right config function based on provider choice
    if (provider === 'heuristic' || provider === 'none') {
      cfg = applyModelFlag(cfg, provider);
    } else if (provider === 'ollama') {
      const next = await configureOllama(session, cfg);
      if (!next) {
        session.close();
        return { aborted: true };
      }
      cfg = next;
    } else if (provider === 'openai' || provider === 'openrouter') {
      cfg = await configureOpenAI(session, cfg, provider);
    } else if (provider === 'anthropic') {
      cfg = await configureAnthropic(session, cfg);
    } else if (provider === 'ollama-cloud') {
      cfg = await configureOllamaCloud(session, cfg);
    } else if (provider === 'local') {
      const next = await configureLocal(session, cfg);
      if (!next) {
        session.close();
        return { aborted: true };
      }
      cfg = next;
    }

    const savedAt = saveConfig(repoPath, cfg, options.outDir);
    prompt.note(`Config saved → ${savedAt}`);

    // Save as preset?
    const wantPreset = await prompt.confirm(session, {
      message: 'Save this configuration as a reusable preset?',
      defaultYes: false,
    });
    if (wantPreset) {
      const name = await prompt.text(session, {
        message: 'Preset name',
        defaultValue: `${provider}-${path.basename(repoPath)}`,
      });
      try {
        savePreset(name, cfg);
        prompt.note(`Preset saved as "${name}". Apply elsewhere with: reporose preset use ${name} <path>`);
      } catch (err) {
        prompt.note(`Could not save preset: ${err.message}`);
      }
    }

    // Run analyze?
    const wantAnalyze = await prompt.confirm(session, {
      message: `Run \`reporose analyze\` on ${repoPath} now?`,
      defaultYes: provider === 'none' || provider === 'heuristic',
    });

    session.close();
    prompt.outro('Setup complete.');
    return { configPath: savedAt, runAnalyze: wantAnalyze, repoPath };
  } catch (err) {
    session.close();
    if (err && err.message === 'aborted') {
      prompt.outro('Cancelled.');
      return { aborted: true };
    }
    throw err;
  }
}

module.exports = { init };
