'use strict';

// main CLI commands — analyze, serve, config, etc
// this is where the magic happens (or at least where its dispatched)

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { scan } = require('../core/scanner');
const { mapDependencies } = require('../core/mapper');
const { summarize } = require('../ai/summarizer');
const {
  loadConfig,
  loadUserConfig,
  saveConfig,
  saveUserConfig,
  applyModelFlag,
  applyModelPath,
  applyApiKeyEnv,
  applyBaseUrl,
  applyModelName,
  applyOllamaOption,
  applyConcurrency,
  configPath,
  userConfigPath,
  listPresets,
  savePreset,
  deletePreset,
  applyPreset,
  loadPreset,
  presetsPath,
  presetModelLabel,
} = require('../ai/config');
const { start: startServer } = require('../server/server');
const { init: initWizard } = require('./init');
const terminal = require('./terminal');

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[reporose] ${message}`);
}

function warn(message) {
  // eslint-disable-next-line no-console
  console.warn(`[reporose] ${message}`);
}

function error(message) {
  // eslint-disable-next-line no-console
  console.error(`[reporose] ${message}`);
}

// analyze command — the main one everyone uses
// scans repo, maps deps, runs AI summaries, writes map.json
// takes a while but its worth it
async function analyze(targetPath, options = {}) {
  const repoPath = path.resolve(targetPath || process.cwd());

  if (!fs.existsSync(repoPath)) {
    error(`Path does not exist: ${repoPath}`);
    const err = new Error(`Path does not exist: ${repoPath}`);
    err.code = 'ENOENT';
    throw err;
  }

  if (!options.silent) {
    terminal.start();
    terminal.log(`Analyzing ${repoPath}`);
  }
  const start = Date.now();

  const map = await scan(repoPath, {
    onProgress: options.silent ? undefined : (msg) => {
      // Extract file counts from progress messages for terminal
      const countMatch = msg.match(/Scanned (\d+) files/);
      if (countMatch) {
        terminal.updateStats({ filesFound: parseInt(countMatch[1], 10) });
      }
      terminal.log(msg);
    },
    onLog: (level, message) => {
      if (options.silent) return;
      if (level === 'warn') warn(message);
      else error(message);
    },
    includeHidden: options.includeHidden,
    includeDocs: options.includeDocs,
    includeMedia: options.includeMedia,
  });

  if (!options.silent) {
    const filesSummarizable = map.files.filter(f => f.summarizable !== false && f.type === 'code').length;
    terminal.updateStats({ filesFound: map.files.length, filesSummarizable });
  }

  if (options.map !== false) {
    if (!options.silent) terminal.log('Computing dependency map');
    mapDependencies(map);
  }

  // Resolve the output path now so we can persist the map incrementally
  // throughout summarization. If the user Ctrl+Cs mid-run, the version on
  // disk reflects every description we've completed so far.
  const outDir = path.resolve(repoPath, options.outDir || '.reporose');
  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, 'map.json');

  /**
   * Atomic write: serialize JSON to <outputPath>.tmp then rename. The
   * rename is atomic on POSIX (and well-behaved on Windows when the target
   * lives on the same filesystem), so a SIGINT mid-write cannot corrupt
   * the existing file.
   */
  function writeMapAtomic() {
    const tmp = outputPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n');
    fs.renameSync(tmp, outputPath);
  }

  // Concurrent workers in summarize() may complete near-simultaneously.
  // Chain writes onto a queue so they happen serially and the final
  // rename always reflects the latest in-memory state.
  let writeQueue = Promise.resolve();
  function schedulePersist() {
    writeQueue = writeQueue.then(() => {
      try { writeMapAtomic(); } catch (_e) { /* best effort */ }
    });
    return writeQueue;
  }

  // Snapshot 1: write the post-mapping skeleton (with empty descriptions).
  // Even if Phase 3 is killed before producing a single description, the
  // user still has a usable structural map on disk.
  writeMapAtomic();

  let summarizeStats = null;
  if (options.summarize !== false) {
    const cfg = options.config || loadConfig(repoPath, options.outDir);
    const modelLabel = presetModelLabel(cfg) || 'unknown';
    terminal.updateStats({ modelLabel: `${cfg.ai.provider}/${modelLabel}` });

    summarizeStats = await summarize(map, {
      repoPath,
      config: cfg,
      outDir: options.outDir,
      onProgress: options.silent ? undefined : (msg) => terminal.updateProgress(msg),
      onStream: options.silent ? undefined : (text) => terminal.updateLiveAi(text),
      onLog: (level, message) => {
        if (options.silent) return;
        if (level === 'warn') terminal.warn(message);
        else if (level === 'info') terminal.log(message);
        else terminal.error(message);
      },
      // Persist after every file: cache hit, fresh AI call, or final flush.
      onFileSummarized: () => schedulePersist(),
    });
  }

  // Final flush: make sure the very last description (and any trailing
  // changes from the worker pool) lands on disk before we report success.
  await writeQueue;
  writeMapAtomic();

  if (!options.silent) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    terminal.log(
      `Analyzed ${map.metadata.files_analyzed} files ` +
        `(${map.metadata.files_ignored} ignored) in ${elapsed}s`,
    );
    if (options.map !== false) {
      terminal.log(
        `Mapped ${map.links.length} links, ` +
          `${map.circular_dependencies.length} cycles, ` +
          `${map.networks.length} networks`,
      );
    }
    if (summarizeStats) {
      terminal.log(
        `Summarized ${summarizeStats.files} files / ${summarizeStats.functions} functions ` +
          `(${summarizeStats.files_from_cache} files cached) via ${summarizeStats.provider}`,
      );
    }
    terminal.done(`Map written to ${outputPath}`);
  }

  return { outputPath, map, summarizeStats };
}

// summarize command — re-runs AI on existing map.json
// useful if you change AI provider or the previous run got interrupted
async function summarizeCmd(targetPath, options = {}) {
  const repoPath = path.resolve(targetPath || process.cwd());
  const dir = path.resolve(repoPath, options.outDir || '.reporose');
  const inputPath = path.join(dir, 'map.json');

  if (!fs.existsSync(inputPath)) {
    const err = new Error(
      `Cannot find ${inputPath}. Run "reporose analyze" first.`,
    );
    err.code = 'ENOENT';
    throw err;
  }

  const map = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const cfg = options.config || loadConfig(repoPath, options.outDir);

  if (!options.silent) {
    terminal.start();
  }
  const modelLabel = presetModelLabel(cfg) || 'unknown';
  terminal.updateStats({ modelLabel: `${cfg.ai.provider}/${modelLabel}` });

  // Atomic, serialized incremental writes — same approach as `analyze`.
  function writeMapAtomic() {
    const tmp = inputPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n');
    fs.renameSync(tmp, inputPath);
  }
  let writeQueue = Promise.resolve();
  const schedulePersist = () => {
    writeQueue = writeQueue.then(() => {
      try { writeMapAtomic(); } catch (_e) { /* best effort */ }
    });
    return writeQueue;
  };

  const stats = await summarize(map, {
    repoPath,
    config: cfg,
    provider: options.provider, // optional pre-built provider (advanced callers / tests)
    outDir: options.outDir,
    onProgress: options.silent ? undefined : (msg) => terminal.updateProgress(msg),
    onStream: options.silent ? undefined : (text) => terminal.updateLiveAi(text),
    onLog: (level, message) => {
      if (options.silent) return;
      if (level === 'warn') terminal.warn(message);
      else if (level === 'info') terminal.log(message);
      else terminal.error(message);
    },
    onFileSummarized: () => schedulePersist(),
  });

  await writeQueue;
  writeMapAtomic();
  if (!options.silent) {
    terminal.log(
      `Summarized ${stats.files} files / ${stats.functions} functions ` +
        `(${stats.files_from_cache} files cached) via ${stats.provider}`,
    );
    terminal.done(`Map updated at ${inputPath}`);
  }

  return { outputPath: inputPath, map, stats };
}

// reset command — deletes cache and map.json
// "turn it off and on again" for reporose
async function resetCmd(targetPath, options = {}) {
  const repoPath = path.resolve(targetPath || process.cwd());
  const dir = path.resolve(repoPath, options.outDir || '.reporose');
  const mapPath = path.join(dir, 'map.json');
  const cachePath = path.join(dir, 'cache', 'summaries.json');

  const pathsToDelete = [];
  if (fs.existsSync(mapPath)) pathsToDelete.push(mapPath);
  if (fs.existsSync(cachePath)) pathsToDelete.push(cachePath);

  if (pathsToDelete.length === 0) {
    if (!options.silent) log('Nothing to reset — no cache or map found.');
    return false;
  }

  // Confirmation unless --yes
  if (!options.yes && !options.silent) {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise((resolve) => {
      rl.question(`Delete ${pathsToDelete.length} file(s)? [y/N] `, resolve);
    });
    rl.close();
    if (!/^y(es)?$/i.test(answer)) {
      log('Cancelled.');
      return false;
    }
  }

  for (const p of pathsToDelete) {
    try {
      fs.unlinkSync(p);
      if (!options.silent) log(`Deleted: ${p}`);
    } catch (e) {
      error(`Failed to delete ${p}: ${e.message}`);
    }
  }

  if (!options.silent) log('Reset complete. Run `reporose analyze` to rebuild.');
  return true;
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  let args;
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (_e) {
    return false;
  }
}

// serve command — starts the 3D visualization server
// opens browser automatically cuz why not
async function serveCmd(targetPath, options = {}) {
  const repoPath = path.resolve(targetPath || process.cwd());
  const dir = path.resolve(repoPath, options.outDir || '.reporose');
  const mapPath = path.join(dir, 'map.json');

  if (!fs.existsSync(mapPath)) {
    const err = new Error(
      `Cannot find ${mapPath}. Run "reporose analyze" first.`,
    );
    err.code = 'ENOENT';
    throw err;
  }

  const { server, port, url } = await startServer({
    mapPath,
    port: options.port == null ? 8689 : Number(options.port),
    host: options.host,
    silent: !!options.silent,
    onLog: (method, reqUrl) => terminal.serveLog(method, reqUrl),
    onError: (method, reqUrl, errMessage) => terminal.serveError(method, reqUrl, errMessage),
  });

  if (!options.silent) {
    terminal.startServe(url, mapPath);
  }

  if (options.open !== false) {
    openBrowser(url);
  }

  // Graceful shutdown.
  const shutdown = () => {
    if (!options.silent) terminal.log('Shutting down...');
    terminal.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, port, url };
}

// config command — read/write .reporose/config.json
// has about a million options cuz AI providers are complicated
// and I defiently wrote all of itby hand ;)
async function configCmd(options = {}) {
  const repoPath = path.resolve(options.path || process.cwd());
  let cfg = options.user ? loadUserConfig() : loadConfig(repoPath, options.outDir);

  let mutated = false;
  if (options.usePreset) {
    cfg = applyPreset(cfg, options.usePreset);
    mutated = true;
  }
  if (options.model) {
    cfg = applyModelFlag(cfg, options.model);
    mutated = true;
  }
  if (options.ollamaUrl) {
    cfg.ai = cfg.ai || {};
    cfg.ai.ollama = cfg.ai.ollama || {};
    cfg.ai.ollama.base_url = options.ollamaUrl;
    mutated = true;
  }
  if (options.ollamaModel) {
    cfg.ai = cfg.ai || {};
    cfg.ai.ollama = cfg.ai.ollama || {};
    cfg.ai.ollama.model = options.ollamaModel;
    mutated = true;
  }
  if (options.baseUrl) {
    cfg = applyBaseUrl(cfg, options.baseUrl);
    mutated = true;
  }
  if (options.modelName) {
    cfg = applyModelName(cfg, options.modelName);
    mutated = true;
  }
  if (options.modelPath) {
    cfg = applyModelPath(cfg, path.resolve(options.modelPath));
    mutated = true;
  }
  if (options.apiKeyEnv) {
    cfg = applyApiKeyEnv(cfg, options.apiKeyEnv);
    mutated = true;
  }
  if (options.numCtx != null) {
    cfg = applyOllamaOption(cfg, 'num_ctx', Number(options.numCtx));
    mutated = true;
  }
  if (options.temperature != null) {
    cfg = applyOllamaOption(cfg, 'temperature', Number(options.temperature));
    mutated = true;
  }
  if (options.numPredict != null) {
    cfg = applyOllamaOption(cfg, 'num_predict', Number(options.numPredict));
    mutated = true;
  }
  if (options.concurrency != null) {
    cfg = applyConcurrency(cfg, options.concurrency);
    mutated = true;
  }

  let savedAt = null;
  if (mutated) {
    savedAt = options.user ? saveUserConfig(cfg) : saveConfig(repoPath, cfg, options.outDir);
  }

  if (!options.silent) {
    if (savedAt) log(`Config saved to ${savedAt}`);
    else log(`Config at ${options.user ? userConfigPath() : configPath(repoPath, options.outDir)}`);
    const ai = cfg.ai || {};
    log(`  provider:                ${ai.provider}`);
    log(`  model label:             ${presetModelLabel(cfg) || ai.model || ''}`);
    if (ai.provider === 'ollama' && ai.ollama) {
      log(`  ollama.base_url:         ${ai.ollama.base_url}`);
      log(`  ollama.model:            ${ai.ollama.model}`);
      log(`  ollama.options:          ${JSON.stringify(ai.ollama.options || {})}`);
      log(`  ollama.concurrency:      ${ai.ollama.concurrency || 'auto'}`);
    } else if (ai.provider === 'openai' && ai.openai) {
      log(`  openai.base_url:         ${ai.openai.base_url}`);
      log(`  openai.model:            ${ai.openai.model}`);
      log(`  openai.api_key_env:      ${ai.openai.api_key_env}`);
    } else if (ai.provider === 'openrouter' && ai.openrouter) {
      log(`  openrouter.base_url:     ${ai.openrouter.base_url}`);
      log(`  openrouter.model:        ${ai.openrouter.model}`);
      log(`  openrouter.api_key_env:  ${ai.openrouter.api_key_env}`);
    } else if (ai.provider === 'local' && ai.local) {
      log(`  local.model_path:        ${ai.local.model_path}`);
    }
  }

  return { config: cfg, configPath: options.user ? userConfigPath() : configPath(repoPath, options.outDir) };
}

// preset command — manage saved configurations
// like "my-ollama-setup" or "work-laptop-config"
async function presetCmd(action, name, targetPath, options = {}) {
  if (!action || action === 'list') {
    const items = listPresets();
    if (!options.silent) {
      log(`Presets at ${presetsPath()}:`);
      if (!items.length) log('  (none defined)');
      for (const p of items) {
        log(`  ${p.name.padEnd(20)} → ${p.provider} (${p.model || '—'})`);
      }
    }
    return { presets: items };
  }

  if (!name) throw new Error(`\`preset ${action}\` requires a preset name.`);

  if (action === 'save') {
    const repoPath = path.resolve(targetPath || process.cwd());
    const cfg = loadConfig(repoPath, options.outDir);
    savePreset(name, cfg);
    if (!options.silent) log(`Saved preset "${name}" to ${presetsPath()}`);
    return { name };
  }
  if (action === 'use' || action === 'apply') {
    const repoPath = path.resolve(targetPath || process.cwd());
    let cfg = loadConfig(repoPath, options.outDir);
    cfg = applyPreset(cfg, name);
    const savedAt = saveConfig(repoPath, cfg, options.outDir);
    if (!options.silent) log(`Applied preset "${name}" → ${savedAt}`);
    return { name, configPath: savedAt };
  }
  if (action === 'show') {
    const cfg = loadPreset(name);
    if (!options.silent) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(cfg, null, 2));
    }
    return { name, config: cfg };
  }
  if (action === 'delete' || action === 'remove' || action === 'rm') {
    const ok = deletePreset(name);
    if (!options.silent) log(ok ? `Deleted preset "${name}"` : `Preset "${name}" not found`);
    return { name, deleted: ok };
  }

  throw new Error(`Unknown preset action: ${action}. Use list | save | use | show | delete.`);
}

// map command — re-runs dependency mapping on existing map.json
// faster than full re-analyze if you just want updated deps
async function mapCmd(targetPath, options = {}) {
  const repoPath = path.resolve(targetPath || process.cwd());
  const dir = path.resolve(repoPath, options.outDir || '.reporose');
  const inputPath = path.join(dir, 'map.json');

  if (!fs.existsSync(inputPath)) {
    const err = new Error(
      `Cannot find ${inputPath}. Run "reporose analyze" first.`,
    );
    err.code = 'ENOENT';
    throw err;
  }

  const raw = fs.readFileSync(inputPath, 'utf8');
  const map = JSON.parse(raw);
  mapDependencies(map);
  fs.writeFileSync(inputPath, JSON.stringify(map, null, 2) + '\n');

  if (!options.silent) {
    log(
      `Mapped ${map.links.length} links, ` +
        `${map.circular_dependencies.length} cycles, ` +
        `${map.networks.length} networks`,
    );
    log(`Map updated at ${inputPath}`);
  }

  return { outputPath: inputPath, map };
}

// who needs help?? isnt everyone a genious
function printHelp() {
  // eslint-disable-next-line no-console
  console.log(
    [
      'Usage: reporose <command> [options]',
      '',
      'Commands:',
      '  init [path]                     Interactive setup wizard (recommended first run)',
      '  analyze [path]                  Scan repo → .reporose/map.json (Phase 1+2+3)',
      '  map [path]                      Re-run Phase 2 (dependency mapping) only',
      '  summarize [path]                Re-run Phase 3 (AI descriptions) only',
      '  serve [path]                    Launch 3D visualization (Phase 4)',
      '  config [path]                   Read or update .reporose/config.json',
      '  preset list|save|use|show|delete <name> [path]   Manage user-level presets',
      '  help                            Show this help text',
      '',
      'Options for `analyze`:',
      '  --out <dir>                Output directory (default: .reporose)',
      '  --silent                   Suppress progress logging',
      '  --no-map                   Skip Phase 2 dependency mapping',
      '  --no-summarize             Skip Phase 3 description generation',
      '  --include-hidden           Include dot-folders (.vscode, .github, etc.)',
      '  --include-docs             Include docs (.md, .txt, .html, etc.)',
      '  --include-media            Include media (.png, .jpg, .svg, .mp4, etc.)',
      '',
      'Options for `serve`:',
      '  --port <n>                 Desired port (default: 8689, auto-falls-back)',
      '  --host <addr>              Bind address (default: 127.0.0.1)',
      '  --no-open                  Do not open the browser automatically',
      '  --silent                   Suppress request logs',
      '',
      'Options for `config`:',
      '  --model <preset|name>      heuristic | none | ollama | openai | openrouter | local',
      '                             ("cloud" is alias for openrouter, "offline" for heuristic)',
      '  --use-preset <name>        Apply a saved user-level preset',
      '  --model-name <name>        Set the model name for the active provider',
      '  --base-url <url>           Set the base URL for the active provider',
      '  --api-key-env <var>        Env var name holding the API key (openai/openrouter)',
      '  --model-path <path>        Path to a local GGUF model file (--model local)',
      '  --ollama-url <url>         Shortcut: ollama base URL (default http://localhost:11434)',
      '  --ollama-model <name>      Shortcut: ollama model (e.g. qwen2.5-coder:3b-instruct-q4_K_M)',
      '  --num-ctx <n>              Ollama option num_ctx',
      '  --temperature <f>          Ollama option temperature',
      '  --num-predict <n>          Ollama option num_predict',
      '  --concurrency <n|auto>     Parallel inference workers (ollama/local)',
      '  --show                     Print the current configuration',
      '',
      'Examples:',
      '  reporose config /repo --model ollama \\',
      '    --ollama-model qwen2.5-coder:3b-instruct-q4_K_M \\',
      '    --num-ctx 32000 --temperature 0 --num-predict 10000',
      '  reporose preset save my-ollama /repo',
      '  reporose preset use my-ollama /other-repo',
      '  reporose config /repo --model openai --model-name gpt-4o-mini --api-key-env OPENAI_API_KEY',
      '  reporose config /repo --model none      # disable AI descriptions',
      '  reporose analyze /repo                  # uses configured provider',
      '  reporose serve /repo                    # 3D visualization on :8689',
    ].join('\n'),
  );
}

const BOOLEAN_FLAGS = new Set([
  'silent',
  'no-map',
  'no-summarize',
  'no-open',
  'include-hidden',
  'include-docs',
  'include-media',
  'user',
  'show',
  'help',
  'verbose',
  'reset',
  'yes',
  'y',
  'no-auto-init',
  'skip-agents-md',
]);

// argument parser — turns CLI args into { positional, flags }
// supports --flag value, --flag=value, and boolean flags
// basically a mini minimist cuz i didnt want the dependency
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      let key = arg.slice(2);
      const eq = key.indexOf('=');
      if (eq !== -1) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// main entry point — dispatches to the right command
// called by bin/cli.js with the parsed arguments
// this is like the big boss
async function run(argv) {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  if (command === 'init' || command === 'setup') {
    const { positional, flags } = parseArgs(rest);
    const target = positional[0] || process.cwd();
    const result = await initWizard(target, {
      outDir: typeof flags.out === 'string' ? flags.out : undefined,
    });
    if (result && result.runAnalyze) {
      await analyze(result.repoPath, {
        outDir: typeof flags.out === 'string' ? flags.out : undefined,
      });
    }
    return 0;
  }

  if (command === 'analyze') {
    const { positional, flags } = parseArgs(rest);
    const target = positional[0] || process.cwd();
    const yesMode = !!flags.yes || !!flags.y;

    // Handle --reset flag: clear cache and map first
    if (flags.reset) {
      const didReset = await resetCmd(target, {
        outDir: typeof flags.out === 'string' ? flags.out : undefined,
        yes: yesMode,
        silent: !!flags.silent,
      });
      if (!didReset && !yesMode) {
        // User cancelled the reset confirmation
        return 0;
      }
    }

    // Auto-init: if no config exists and --no-auto-init not set, run init wizard
    if (!flags['no-auto-init']) {
      const configPath = require('../ai/config').configPath(target, typeof flags.out === 'string' ? flags.out : undefined);
      if (!fs.existsSync(configPath)) {
        if (!flags.silent) log('No config found. Running init wizard...');
        const initResult = await initWizard(target, {
          outDir: typeof flags.out === 'string' ? flags.out : undefined,
          silent: !!flags.silent,
        });
        if (initResult.aborted) {
          return 0;
        }
        // Continue to analyze after init
      }
    }

    await analyze(target, {
      outDir: typeof flags.out === 'string' ? flags.out : undefined,
      silent: !!flags.silent,
      map: flags['no-map'] ? false : true,
      summarize: flags['no-summarize'] ? false : true,
      includeHidden: !!flags['include-hidden'],
      includeDocs: !!flags['include-docs'],
      includeMedia: !!flags['include-media'],
      skipAgentsMd: !!flags['skip-agents-md'],
    });
    return 0;
  }

  if (command === 'map') {
    const { positional, flags } = parseArgs(rest);
    const target = positional[0] || process.cwd();
    await mapCmd(target, {
      outDir: typeof flags.out === 'string' ? flags.out : undefined,
      silent: !!flags.silent,
    });
    return 0;
  }

  if (command === 'summarize') {
    const { positional, flags } = parseArgs(rest);
    const target = positional[0] || process.cwd();
    await summarizeCmd(target, {
      outDir: typeof flags.out === 'string' ? flags.out : undefined,
      silent: !!flags.silent,
    });
    return 0;
  }

  if (command === 'serve') {
    const { positional, flags } = parseArgs(rest);
    const target = positional[0] || process.cwd();

    // Auto-init: if no config exists and --no-auto-init not set, run init wizard
    if (!flags['no-auto-init']) {
      const configPath = require('../ai/config').configPath(target, typeof flags.out === 'string' ? flags.out : undefined);
      if (!fs.existsSync(configPath)) {
        if (!flags.silent) log('No config found. Running init wizard...');
        const initResult = await initWizard(target, {
          outDir: typeof flags.out === 'string' ? flags.out : undefined,
          silent: !!flags.silent,
        });
        if (initResult.aborted) {
          return 0;
        }
        // Continue to serve after init
      }
    }

    await serveCmd(target, {
      outDir: typeof flags.out === 'string' ? flags.out : undefined,
      port: typeof flags.port === 'string' ? Number(flags.port) : undefined,
      host: typeof flags.host === 'string' ? flags.host : undefined,
      open: flags['no-open'] ? false : true,
      silent: !!flags.silent,
    });
    // serve is intentionally long-running — return null so we don't exit.
    return null;
  }

  if (command === 'config') {
    const { positional, flags } = parseArgs(rest);
    const action = positional[0];
    const isUser = !!flags.user;

    if (action === 'show') {
      await configCmd({
        path: positional[1] || process.cwd(),
        user: isUser,
        show: true,
        silent: !!flags.silent,
      });
      return 0;
    }

    if (action === 'set') {
      const key = positional[1];
      const value = positional[2];
      if (!key || value === undefined) {
        throw new Error('Usage: reporose config set [--user] <key> <value> [path]');
      }

      const normalized = String(key).toLowerCase().replace(/-/g, '_');
      const setOptions = {
        path: positional[3] || process.cwd(),
        user: isUser,
        silent: !!flags.silent,
      };

      if (normalized === 'provider') setOptions.model = value;
      else if (normalized === 'model' || normalized === 'model_name') setOptions.modelName = value;
      else if (normalized === 'model_path') setOptions.modelPath = value;
      else if (normalized === 'base_url') setOptions.baseUrl = value;
      else if (normalized === 'api_key_env') setOptions.apiKeyEnv = value;
      else if (normalized === 'ollama_url') setOptions.ollamaUrl = value;
      else if (normalized === 'ollama_model') setOptions.ollamaModel = value;
      else if (normalized === 'num_ctx') setOptions.numCtx = value;
      else if (normalized === 'temperature') setOptions.temperature = value;
      else if (normalized === 'num_predict') setOptions.numPredict = value;
      else if (normalized === 'concurrency') setOptions.concurrency = value;
      else if (normalized === 'use_preset' || normalized === 'preset') setOptions.usePreset = value;
      else {
        throw new Error(
          `Unknown config key: ${key}. ` +
            'Use provider|model|model_name|model_path|base_url|api_key_env|ollama_url|ollama_model|num_ctx|temperature|num_predict|concurrency|use_preset.',
        );
      }

      await configCmd(setOptions);
      return 0;
    }

    await configCmd({
      path: positional[0] || process.cwd(),
      user: isUser,
      outDir: typeof flags.out === 'string' ? flags.out : undefined,
      model: typeof flags.model === 'string' ? flags.model : undefined,
      modelName: typeof flags['model-name'] === 'string' ? flags['model-name'] : undefined,
      modelPath: typeof flags['model-path'] === 'string' ? flags['model-path'] : undefined,
      apiKeyEnv: typeof flags['api-key-env'] === 'string' ? flags['api-key-env'] : undefined,
      baseUrl: typeof flags['base-url'] === 'string' ? flags['base-url'] : undefined,
      ollamaUrl: typeof flags['ollama-url'] === 'string' ? flags['ollama-url'] : undefined,
      ollamaModel: typeof flags['ollama-model'] === 'string' ? flags['ollama-model'] : undefined,
      numCtx: typeof flags['num-ctx'] === 'string' ? flags['num-ctx'] : undefined,
      temperature: typeof flags.temperature === 'string' ? flags.temperature : undefined,
      numPredict: typeof flags['num-predict'] === 'string' ? flags['num-predict'] : undefined,
      concurrency: typeof flags.concurrency === 'string' ? flags.concurrency : undefined,
      usePreset: typeof flags['use-preset'] === 'string' ? flags['use-preset'] : undefined,
      show: !!flags.show,
      silent: !!flags.silent,
    });
    return 0;
  }

  if (command === 'preset') {
    const { positional, flags } = parseArgs(rest);
    const action = positional[0] || 'list';
    const name = positional[1];
    const target = positional[2];
    await presetCmd(action, name, target, {
      outDir: typeof flags.out === 'string' ? flags.out : undefined,
      silent: !!flags.silent,
    });
    return 0;
  }

  if (command === 'reset') {
    const { positional, flags } = parseArgs(rest);
    const target = positional[0] || process.cwd();
    await resetCmd(target, {
      outDir: typeof flags.out === 'string' ? flags.out : undefined,
      yes: !!flags.yes || !!flags.y,
      silent: !!flags.silent,
    });
    return 0;
  }

  if (command === 'mcp') {
    const { positional, flags } = parseArgs(rest);
    const target = positional[0] || process.cwd();
    const { startMcpServer } = require('../mcp/server');
    await startMcpServer(target, {
      outDir: typeof flags.out === 'string' ? flags.out : undefined,
    });
    // MCP server runs until terminated
    return null;
  }

  error(`Unknown command: ${command}`);
  printHelp();
  return 1;
}

module.exports = {
  analyze,
  map: mapCmd,
  summarize: summarizeCmd,
  serve: serveCmd,
  reset: resetCmd,
  config: configCmd,
  preset: presetCmd,
  init: initWizard,
  run,
  printHelp,
  parseArgs,
};
