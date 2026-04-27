'use strict';

// the big summarizer — phase 3 of reporose
// takes the scanned/map.json data and runs AI on it to generate descriptions
// handles caching, retries, concurrency, the whole shebang

const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildFileInput, buildFullFileInput, renderFullFilePrompt } = require('./prompts');
const { ensurePreamble } = require('../utils/agents-md');
const { createHeuristicProvider } = require('./heuristic');
const { createOpenRouterProvider } = require('./openrouter');
const { createOpenAIProvider } = require('./openai');
const { createAnthropicProvider } = require('./anthropic');
const { createOllamaProvider } = require('./ollama');
const { createLocalProvider } = require('./local');

// bump this if cache format changes
const CACHE_VERSION = 1;
















/* ------------------------------------------------------------------ */
/* Progress bar                                                        */
/* ------------------------------------------------------------------ */

// renders a fancy progress bar like: 45% ▕████████░░░░░░░░░░▏ (9/20)
function renderProgressBar(current, total, width = 40) {
  const percentage = Math.round((current / total) * 100);
  const filled = Math.round((width * current) / total);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `${percentage}% ▕${bar}▏ (${current}/${total})`;
}
// how many bytes to read for snippet-based summarization
const SNIPPET_LENGTH = 500;

// retry delays: 1s, 2s, 4s, 8s, 16s (exponential backoff)
const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
















/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

// cache lives at .reporose/cache/summaries.json
// stores file hashes and their descriptions so we dont re-run AI on unchanged files

function cachePath(repoPath, outDir) {
  return path.resolve(repoPath, outDir || '.reporose', 'cache', 'summaries.json');
}

// loads the cache file, returns empty cache if missing or corrupted
function loadCache(repoPath, outDir) {
  const file = cachePath(repoPath, outDir);
  if (!fs.existsSync(file)) return { version: CACHE_VERSION, files: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || raw.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, files: {} };
    }
    if (!raw.files || typeof raw.files !== 'object') raw.files = {};
    return raw;
  } catch (_e) {
    return { version: CACHE_VERSION, files: {} };
  }
}

// saves cache to disk atomically (writes tmp file then renames)
// so a crash mid-write doesnt corrupt the cache
function saveCache(repoPath, cache, outDir) {
  const file = cachePath(repoPath, outDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic write: tmp file then rename. Prevents a half-written cache if the
  // process is killed mid-write — important now that we save on every file.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return file;
}
















/* ------------------------------------------------------------------ */
/* Retry with exponential backoff                                      */
/* ------------------------------------------------------------------ */

// cuz AI APIs fail sometimes, and we dont want to give up immediately

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// retries an async fn with exponential backoff
// handles 429 rate limit specially by looking for retry-after headers
async function retryWithBackoff(fn, options = {}) {
  const delays = options.delays || DEFAULT_BACKOFF_MS;
  let attempt = 0;
  // First attempt + N retries
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delays.length) throw err;
      
      // Handle 429 rate limit errors with longer delays
      const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));
      if (isRateLimit) {
        // Parse retry-after from error message if present
        const retryMatch = err.message && err.message.match(/retry after (\d+\.?\d*)/i);
        const retryAfterMs = err.retryAfter != null ? err.retryAfter : (retryMatch ? parseFloat(retryMatch[1]) * 1000 : null);
        
        // Use retry-after if available, otherwise use longer backoff for rate limits
        const waitMs = retryAfterMs || Math.max(delays[attempt], 2000 * (attempt + 1));
        if (options.onRetry) options.onRetry(attempt + 1, err);
        await sleep(waitMs);
      } else {
        if (options.onRetry) options.onRetry(attempt + 1, err);
        await sleep(delays[attempt]);
      }
      attempt += 1;
    }
  }
}
















/* ------------------------------------------------------------------ */
/* Provider selection                                                  */
/* ------------------------------------------------------------------ */

// picks which AI provider to use based on config
// if it fails to init, returns SKIP_PROVIDER so we just leave descriptions empty

const SKIP_PROVIDER = Object.freeze({ name: 'none', skip: true });

async function selectProvider(config, onLog = () => {}) {
  const ai = (config && config.ai) || {};
  const provider = ai.provider || 'heuristic';

  if (provider === 'none') {
    return SKIP_PROVIDER;
  }

  if (provider === 'heuristic') {
    return createHeuristicProvider();
  }

  // For real providers we DO NOT silently fall back to heuristic on failure.
  // The user explicitly asked for a real model; if it's unavailable we skip
  // Phase 3 so descriptions stay empty rather than being silently downgraded.
  if (provider === 'ollama') {
    try {
      return await createOllamaProvider(ai.ollama || {});
    } catch (err) {
      onLog('warn', `Ollama unavailable: ${err.message} — skipping descriptions.`);
      return SKIP_PROVIDER;
    }
  }
  if (provider === 'ollama-cloud') {
    // Ollama Cloud speaks the exact same /api/chat protocol as a local
    // daemon, but at https://ollama.com with bearer auth. We reuse the
    // same factory and feed it the cloud config block.
    try {
      const cloudCfg = ai['ollama-cloud'] || {};
      return await createOllamaProvider({
        base_url: cloudCfg.base_url || 'https://ollama.com',
        api_key_env: cloudCfg.api_key_env || 'OLLAMA_API_KEY',
        model: cloudCfg.model || 'gpt-oss:20b-cloud',
        options: cloudCfg.options,
        timeout_ms: cloudCfg.timeout_ms,
        name: 'ollama-cloud',
      });
    } catch (err) {
      onLog('warn', `Ollama Cloud unavailable: ${err.message} — skipping descriptions.`);
      return SKIP_PROVIDER;
    }
  }
  if (provider === 'anthropic') {
    try {
      return createAnthropicProvider(ai.anthropic || {});
    } catch (err) {
      onLog('warn', `Anthropic unavailable: ${err.message} — skipping descriptions.`);
      return SKIP_PROVIDER;
    }
  }
  if (provider === 'openai') {
    try {
      return createOpenAIProvider(ai.openai || {});
    } catch (err) {
      onLog('warn', `OpenAI unavailable: ${err.message} — skipping descriptions.`);
      return SKIP_PROVIDER;
    }
  }
  if (provider === 'openrouter' || provider === 'cloud') {
    try {
      return createOpenRouterProvider(ai.openrouter || {});
    } catch (err) {
      onLog('warn', `OpenRouter unavailable: ${err.message} — skipping descriptions.`);
      return SKIP_PROVIDER;
    }
  }
  if (provider === 'groq' || provider === 'fast') {
    try {
      const groqCfg = ai.groq || {};
      const isHighTpmModel = (groqCfg.model || '').includes('compound');
      return createOpenAIProvider({
        name: 'groq',
        base_url: groqCfg.base_url || 'https://api.groq.com/openai/v1',
        api_key_env: groqCfg.api_key_env || 'GROQ_API_KEY',
        model: groqCfg.model || 'llama-3.1-8b-instant',
        timeout_ms: groqCfg.timeout_ms || 30_000,
        temperature: 0.2,
        context_size: groqCfg.context_size || 8192,
        // Auto-detect TPM: compound models have 70K, others have 6K
        max_tpm: groqCfg.max_tpm || (isHighTpmModel ? 70000 : 6000),
        min_delay_ms: groqCfg.min_delay_ms,
      });
    } catch (err) {
      onLog('warn', `Groq unavailable: ${err.message} — skipping descriptions.`);
      return SKIP_PROVIDER;
    }
  }
  if (provider === 'local') {
    try {
      return await createLocalProvider(ai.local || {});
    } catch (err) {
      onLog('warn', `Local model unavailable: ${err.message} — skipping descriptions.`);
      return SKIP_PROVIDER;
    }
  }

  onLog('warn', `Unknown provider "${provider}"; using heuristic.`);
  return createHeuristicProvider();
}
















/* ------------------------------------------------------------------ */
/* File reading helpers                                                */
/* ------------------------------------------------------------------ */

// reads just the first N bytes of a file for snippet-based summarization
function readSnippet(absPath, maxBytes = SNIPPET_LENGTH) {
  try {
    const fd = fs.openSync(absPath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.slice(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_e) {
    return '';
  }
}

// reads the entire file content
function readFullFile(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch (_e) {
    return '';
  }
}

// splits big files into chunks that fit in the AI context window
// tries to break at line boundaries so we dont cut mid-function
function chunkContent(content, maxChunkSize = 8000) {
  if (content.length <= maxChunkSize) return [content];

  const chunks = [];
  let start = 0;

  while (start < content.length) {
    let end = Math.min(start + maxChunkSize, content.length);

    // Try to find a line break to split at
    if (end < content.length) {
      const nextNewline = content.indexOf('\n', end - 100);
      if (nextNewline !== -1 && nextNewline < end + 100) {
        end = nextNewline + 1;
      }
    }

    chunks.push(content.slice(start, end));
    start = end;
  }

  return chunks;
}

// topological sort of files by dependency depth
// files with no imports go first so their descriptions are ready
// for files that depend on them
function sortFilesByDependencyDepth(files, repoPath) {
  // Build dependency graph
  const fileByPath = new Map(files.map(f => [f.path, f]));
  const inDegree = new Map();
  const dependents = new Map();

  for (const file of files) {
    inDegree.set(file.path, 0);
    dependents.set(file.path, []);
  }

  for (const file of files) {
    for (const imp of file.imports || []) {
      if (imp.type === 'file') {
        // Resolve the import path to find the source file
        const sourcePath = resolveImportPath(file.path, imp.source, repoPath);
        if (sourcePath && fileByPath.has(sourcePath)) {
          inDegree.set(file.path, (inDegree.get(file.path) || 0) + 1);
          dependents.get(sourcePath).push(file.path);
        }
      }
    }
  }

  // Topological sort using Kahn's algorithm
  const queue = [];
  const result = [];

  for (const [path, degree] of inDegree) {
    if (degree === 0) queue.push(path);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    result.push(current);

    for (const dependent of dependents.get(current) || []) {
      const newDegree = inDegree.get(dependent) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  // Map back to file objects
  const sortedPaths = result.length === files.length ? result : files.map(f => f.path);
  const pathOrder = new Map(sortedPaths.map((p, i) => [p, i]));

  return [...files].sort((a, b) => (pathOrder.get(a.path) || 0) - (pathOrder.get(b.path) || 0));
}

// resolves an import like './utils' to the actual file path
// tries common extensions and index files
function resolveImportPath(fromPath, source, repoPath) {
  // Handle relative imports
  if (source.startsWith('./') || source.startsWith('../')) {
    const fromDir = path.dirname(path.join(repoPath, fromPath));
    let resolved = path.resolve(fromDir, source);

    // Try common extensions
    const extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json'];
    for (const ext of ['', ...extensions]) {
      const withExt = resolved + ext;
      if (fs.existsSync(withExt)) {
        return path.relative(repoPath, withExt);
      }
    }

    // Try index files in directories
    for (const ext of extensions) {
      const indexFile = path.join(resolved, 'index' + ext);
      if (fs.existsSync(indexFile)) {
        return path.relative(repoPath, indexFile);
      }
    }
  }
  return null;
}

// finds AGENTS.md or similar files to give the AI repo context
function loadContextFiles(repoPath) {
  const contextFiles = [];
  const candidates = ['agents.md', 'AGENTS.md', 'Agents.md', 'AGENTS.MD', 'context.md', 'CONTEXT.md'];

  for (const filename of candidates) {
    const fullPath = path.join(repoPath, filename);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        contextFiles.push({ name: filename, content });
      } catch (_e) {
        // Ignore read errors
      }
    }
  }

  return contextFiles;
}
















/* ------------------------------------------------------------------ */
/* Per-call helpers                                                    */
/* ------------------------------------------------------------------ */

// these wrap the provider calls with retries and error handling

// calls the provider to summarize a file, with retries
async function describeFile(provider, fileInput, retryOptions, onLog, onStream) {
  try {
    const desc = await retryWithBackoff(() => provider.summarizeFile(fileInput, onStream), {
      ...retryOptions,
      onRetry: (attempt, err) => {
        if (onLog) onLog('warn', `[file ${fileInput.path}] retry ${attempt}: ${err.message}`);
      },
    });
    if (desc && desc.trim()) return desc.trim();
  } catch (err) {
    if (onLog) onLog('warn', `[file ${fileInput.path}] giving up after retries: ${err.message}`);
  }
  // Provider returned empty / errored — leave description empty rather than
  // silently falling back to heuristic. Heuristic is opt-in via --model heuristic.
  return '';
}

// NOTE: not used anymore since we removed function descriptions
// kept for backwards compatibility
async function describeFunction(provider, fnInput, retryOptions, onLog, onStream) {
  try {
    const desc = await retryWithBackoff(() => provider.summarizeFunction(fnInput, onStream), {
      ...retryOptions,
      onRetry: (attempt, err) => {
        if (onLog) onLog('warn', `[fn ${fnInput.file}::${fnInput.name}] retry ${attempt}: ${err.message}`);
      },
    });
    if (desc && desc.trim()) return desc.trim();
  } catch (err) {
    if (onLog) onLog('warn', `[fn ${fnInput.file}::${fnInput.name}] giving up after retries: ${err.message}`);
  }
  return '';
}
















/* ------------------------------------------------------------------ */
/* RAM-based concurrency                                               */
/* ------------------------------------------------------------------ */

// figures out how many concurrent AI requests we can handle
// based on available RAM and context window size
// bigger context = more memory per request = fewer concurrent

function autoConcurrency(provider, onLog) {
  const numCtx = (provider && provider.contextSize) || 8192;
  let perReqMb;
  if (numCtx <= 4096) perReqMb = 150;
  else if (numCtx <= 8192) perReqMb = 300;
  else if (numCtx <= 16384) perReqMb = 600;
  else perReqMb = 1200;

  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  const freeMb = Math.round(os.freemem() / (1024 * 1024));
  // Be a bit more permissive on big-RAM machines.
  const reservedMb = totalMb >= 16 * 1024 ? 2048 : 1536;
  const usableMb = Math.max(0, freeMb - reservedMb);
  const raw = Math.floor(usableMb / perReqMb);
  const concurrency = Math.max(1, Math.min(6, raw));

  if (onLog) {
    onLog(
      'info',
      `Concurrency: ${concurrency} (free=${freeMb}MB, ctx=${numCtx}, per-req≈${perReqMb}MB)`,
    );
  }
  return concurrency;
}

// resolves concurrency setting from config or auto-calculates it
// ollama defaults to 1 (daemon handles queueing)
// cloud providers default to 1 (rate limits)
// local provider uses autoConcurrency
function resolveConcurrency(config, provider, onLog) {
  const ai = (config && config.ai) || {};
  const providerCfg = ai[provider.name] || {};
  const setting = providerCfg.concurrency;
  // An explicit numeric override always wins, including for Ollama. This
  // lets advanced users dial it down if their daemon has a different
  // OLLAMA_NUM_PARALLEL.
  if (typeof setting === 'number' && setting >= 1) {
    if (onLog) onLog('info', `Concurrency: ${setting} (configured)`);
    return Math.max(1, Math.min(16, Math.floor(setting)));
  }
  // Ollama: serial by default. The daemon's own request queue
  // (OLLAMA_MAX_QUEUE) buffers in-flight requests cleanly, and on iGPUs
  // running with OLLAMA_NUM_PARALLEL=1 a single hot slot consistently
  // beats parallel slots that thrash the KV cache. Users with a beefier
  // setup (more VRAM, OLLAMA_NUM_PARALLEL>1) can bump this via the
  // `ai.ollama.concurrency` config field — that branch is handled above.
  if (provider.name === 'ollama') {
    if (onLog) onLog('info', 'Concurrency: 1 (ollama default — daemon queues requests)');
    return 1;
  }
  // Cloud providers usually rate-limit aggressively; play it safe with 1.
  if (provider.name !== 'local') return 1;
  return autoConcurrency(provider, onLog);
}

// runs workers with limited concurrency using a pool of runners
// like Promise.all but with a max number of concurrent tasks
async function runWithConcurrency(items, concurrency, worker) {
  if (!items.length) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  const runners = new Array(limit).fill(0).map(async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        await worker(items[i], i);
      } catch (_e) {
        // Worker is expected to handle its own errors; ignore here.
      }
    }
  });
  await Promise.all(runners);
}
















/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

// the main summarize function — this is what analyze() calls for phase 3
// takes the map from phase 1/2 and adds descriptions to all files

async function summarize(map, options = {}) {
  // setup callbacks and paths
  const repoPath = options.repoPath ? path.resolve(options.repoPath) : process.cwd();
  const onLog = options.onLog || (() => {});
  const onProgress = options.onProgress || (() => {});
  const onStream = options.onStream || (() => {});

  // pick the provider (heuristic, ollama, openai, etc)
  const provider = options.provider || (await selectProvider(options.config || {}, onLog));

  // check if provider supports full-file mode or just snippets
  const supportsFullFile = provider.summarizeFullFile !== undefined;
  onLog('info', `Using AI provider: ${provider.name}${supportsFullFile ? ' (full-file mode)' : ' (snippet mode)'}`);

  // if provider is 'none' or failed to init, skip phase 3 entirely
  // leaves descriptions empty but doesnt crash
  if (provider && provider.skip) {
    for (const file of map.files) {
      if (file.description == null) file.description = '';
      for (const fn of file.functions || []) {
        if (fn.description == null) fn.description = '';
      }
    }
    return {
      provider: 'none',
      files: 0,
      files_from_cache: 0,
      functions: 0,
      functions_from_cache: 0,
      skipped: true,
    };
  }

  // load the cache so we can skip files that havent changed
  const cache = loadCache(repoPath, options.outDir);
  if (!cache.files) cache.files = {};

  // create/update AGENTS.md if needed (unless --skip-agents-md flag)
  if (!options.skipAgentsMd) {
    const preambleResult = ensurePreamble(repoPath);
    if (preambleResult.created && !options.silent) {
      onLog('info', `Created ${preambleResult.name} with AI agent instructions`);
    } else if (preambleResult.updated && !options.silent) {
      onLog('info', `Updated ${preambleResult.name} with AI agent instructions`);
    }
  }

  let filesProcessed = 0;
  let filesFromCache = 0;
  let functionsProcessed = 0;
  let functionsFromCache = 0;

  const retryOptions = options.backoff ? { delays: options.backoff } : {};

  // load AGENTS.md etc and decide if we can afford to include it in prompts
  // only include if context window is big enough (at least 400 chars budget)
  const contextFiles = loadContextFiles(repoPath);
  let repoContext = '';
  if (contextFiles.length > 0) {
    const ctxSize = (provider && provider.contextSize) || 4096;
    // ctxSize is in tokens; ~4 chars per token gives the byte budget.
    const charBudget = Math.min(4000, Math.floor((ctxSize * 4) * 0.125));
    if (charBudget >= 400) {
      const joined = contextFiles
        .map((c) => `### ${c.name}\n${c.content}`)
        .join('\n\n');
      repoContext = joined.length > charBudget
        ? joined.slice(0, charBudget) + '\n... [truncated]'
        : joined;
      if (!options.silent) {
        onLog(
          'info',
          `Attaching ${contextFiles.map((c) => c.name).join(', ')} ` +
            `(${repoContext.length}/${joined.length} chars) to every prompt`,
        );
      }
    } else if (!options.silent) {
      onLog('info', `Skipping AGENTS.md context — provider ctx (${ctxSize}) is too small`);
    }
  }

  // sort files so dependencies get summarized first
  // this lets us pass dependency descriptions to dependent files
  const sortedFiles = sortFilesByDependencyDepth(map.files, repoPath);
  const totalFiles = sortedFiles.length;

  // only code files get AI summaries (not images, configs, etc)
  const summarizableFiles = sortedFiles.filter(f => f.summarizable !== false && f.type === 'code');
  const totalSummarizable = summarizableFiles.length;

  // Ensure non-summarizable files have empty descriptions
  for (const file of sortedFiles) {
    if (file.summarizable === false || file.type !== 'code') {
      if (file.description == null) file.description = '';
    }
  }

  // map of file paths to their descriptions
  // used to pass dependency context to later files
  const fileDescriptions = new Map();

  // progress tracking
  let filesDone = 0;
  if (!options.silent) {
    onLog('info', `Summarizing ${totalSummarizable} of ${totalFiles} files (${totalFiles - totalSummarizable} non-code skipped)`);
    onLog('info', renderProgressBar(0, totalSummarizable));
  }

  // first pass: handle cache hits synchronously
  // this is fast and ensures dependency descriptions are ready
  const pendingFiles = [];
  let restoredFromCache = false;
  for (const file of summarizableFiles) {
    const cachedFile = cache.files[file.path];
    if (cachedFile && cachedFile.hash === file.hash && cachedFile.description) {
      file.description = cachedFile.description;
      fileDescriptions.set(file.path, file.description);
      for (const fn of file.functions || []) fn.description = '';
      filesFromCache += 1;
      filesDone += 1;
      restoredFromCache = true;
      if (!options.silent && onProgress) {
        onProgress({
          filesAnalyzed: filesDone,
          currentFile: file.path,
          text: renderProgressBar(filesDone, totalSummarizable) + ' [cached: ' + file.path + ']',
        });
      }
      continue;
    }
    pendingFiles.push(file);
  }

  // persist after cache restore so Ctrl+C before workers start still saves progress
  if (restoredFromCache && options.onFileSummarized) {
    try { await options.onFileSummarized(null, map); } catch (_e) { /* ignore */ }
  }

  // figure out how many concurrent requests to run
  const concurrency = resolveConcurrency(options.config, provider, options.silent ? null : onLog);

  // processes one file: gets AI description, updates cache, persists progress
  async function processFile(file) {
    if (!options.silent && onProgress) {
      onProgress({
        filesAnalyzed: filesDone,
        currentFile: file.path,
        text: renderProgressBar(filesDone, totalSummarizable) + ' ' + file.path,
      });
    }

    // gather descriptions of files this one imports
    // best-effort cuz workers run in parallel and deps might not be done yet
    const dependencyDescriptions = {};
    for (const imp of file.imports || []) {
      if (imp.type === 'file') {
        const depPath = resolveImportPath(file.path, imp.source, repoPath);
        if (depPath && fileDescriptions.has(depPath)) {
          dependencyDescriptions[depPath] = fileDescriptions.get(depPath);
        }
      }
    }

    // full-file mode: read whole file, chunk it, summarize chunk by chunk
    if (file.type === 'code' && supportsFullFile) {
      const absPath = path.join(repoPath, file.path);
      const fullContent = readFullFile(absPath);

      if (fullContent) {
        const contextSize = provider.contextSize || 8192;
        const chunkSize = contextSize <= 8192 ? 6000 : 15000;
        const chunks = chunkContent(fullContent, chunkSize);
        const fileInput = buildFullFileInput(file, chunks, { dependencyDescriptions, repoContext });

        let previousDescription = '';
        for (let i = 0; i < chunks.length; i++) {
          const isLastChunk = i === chunks.length - 1;
          const prompt = renderFullFilePrompt(fileInput, i, previousDescription);
          try {
            const desc = await retryWithBackoff(
              () => provider.summarizeFullFile({ ...fileInput, prompt, partIndex: i, isLastChunk }, onStream),
              {
                ...retryOptions,
                onRetry: (attempt, err) => {
                  if (onLog) onLog('warn', `[file ${file.path}] part ${i + 1}/${chunks.length} retry ${attempt}: ${err.message}`);
                },
              },
            );
            if (isLastChunk) {
              file.description = desc && desc.trim() ? desc.trim() : '';
            } else {
              previousDescription = desc && desc.trim() ? desc.trim() : previousDescription;
            }
          } catch (err) {
            if (onLog) onLog('warn', `[file ${file.path}] part ${i + 1} giving up: ${err.message}`);
            if (isLastChunk) file.description = '';
          }
        }
      } else {
        file.description = '';
      }
    } else {
      // snippet mode: just read first 500 bytes and summarize that
      const snippet = file.type === 'code' ? readSnippet(path.join(repoPath, file.path)) : '';
      const fileInput = buildFileInput(file, snippet, { repoContext });
      file.description = await describeFile(provider, fileInput, retryOptions, onLog, onStream);
    }

    fileDescriptions.set(file.path, file.description);
    filesProcessed += 1;
    for (const fn of file.functions || []) fn.description = '';

    cache.files[file.path] = {
      hash: file.hash,
      description: file.description,
      functions: Object.fromEntries(
        (file.functions || []).map((fn) => [fn.id, { description: fn.description || '' }]),
      ),
    };

    // save cache and optionally persist map.json after each file
    // so Ctrl+C doesnt lose progress
    try { saveCache(repoPath, cache, options.outDir); } catch (_e) { /* ignore */ }
    if (options.onFileSummarized) {
      try { await options.onFileSummarized(file, map); } catch (_e) { /* ignore */ }
    }

    filesDone += 1;
    if (!options.silent && onProgress) {
      onProgress({
        filesAnalyzed: filesDone,
        currentFile: file.path,
        text: renderProgressBar(filesDone, totalSummarizable) + ' ' + file.path,
      });
    }
  }

  // run all pending files with limited concurrency
  try {
    await runWithConcurrency(pendingFiles, concurrency, processFile);
    saveCache(repoPath, cache, options.outDir);
  } finally {
    // cleanup provider resources if it has a close method
    if (provider && typeof provider.close === 'function') {
      try { await provider.close(); } catch (_e) { /* ignore */ }
    }
  }

  return {
    provider: provider.name,
    files: filesProcessed,
    files_from_cache: filesFromCache,
    functions: functionsProcessed,
    functions_from_cache: functionsFromCache,
  };
}

module.exports = {
  summarize,
  selectProvider,
  retryWithBackoff,
  loadCache,
  saveCache,
  cachePath,
  readSnippet,
  readFullFile,
  chunkContent,
  sortFilesByDependencyDepth,
  loadContextFiles,
  renderProgressBar,
  autoConcurrency,
  resolveConcurrency,
  runWithConcurrency,
  SKIP_PROVIDER,
  CACHE_VERSION,
  DEFAULT_BACKOFF_MS,
};
