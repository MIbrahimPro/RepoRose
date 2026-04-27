# Reporose Architecture & Logics

This document explains how Reporose works internally — the data flow, key algorithms, and design decisions.

## Overview

Reporose is a repository scanner that builds a structural map of a codebase:
1. **Phase 1 (Scan)** — Walk the filesystem, parse JS/TS AST, extract metadata
2. **Phase 2 (Map)** — Build dependency graph, detect cycles, compute importance scores
3. **Phase 3 (Summarize)** — AI generates file descriptions (functions left empty by design)
4. **Phase 4 (Visualize)** — 3D force-directed graph in the browser

## File Structure

```
src/
├── core/
│   ├── scanner.js      # Phase 1: File walking + AST parsing
│   ├── mapper.js       # Phase 2: Dependency graph + algorithms
│   └── enrich.js       # Metadata enrichment (env vars, tags, routes)
├── ai/
│   ├── summarizer.js   # Phase 3: AI orchestration + caching
│   ├── config.js       # Provider config management
│   ├── heuristic.js    # Rule-based offline provider
│   ├── ollama.js       # Ollama local + cloud provider
│   ├── anthropic.js   # Claude Messages API
│   ├── openai.js      # OpenAI-compatible APIs
│   ├── openrouter.js  # OpenRouter provider
│   ├── groq.js        # Groq fast inference
│   ├── local.js       # node-llama-cpp local GGUF
│   └── prompts.js     # Prompt templates
├── cli/
│   ├── commands.js    # CLI command dispatchers
│   ├── init.js        # Interactive init wizard
│   ├── terminal.js    # Terminal UI (progress bars, spinners)
│   └── prompt.js      # TTY/TTY prompt utilities
├── server/
│   ├── server.js      # Express server
│   ├── search.js      # Full-text search for the API
│   └── public/        # Static frontend files (app.js, index.html, etc)
├── mcp/
│   └── server.js      # MCP stdio server
└── utils/
    ├── secrets.js     # Secure API key storage
    ├── agents-md.js   # AGENTS.md preamble injector
    ├── dotenv.js      # Tiny .env loader
    └── ignore.js      # .gitignore handling
```

## Phase 1: Scanner (`src/core/scanner.js`)

### File Walking
- Uses `walkRepository()` to recursively traverse the repo
- Respects `.gitignore` patterns via `ignore` npm package
- Categories: `code`, `config`, `style`, `docs`, `media`, `data`
- **Aggressive mode** (default): only `code` files get parsed; others are tracked but not AST-parsed

### AST Parsing
- **Parser**: `@babel/parser` with all plugins enabled (JSX, TS, decorators, etc.)
- **Extracts**:
  - `imports`: source path, import names, type (package vs file)
  - `exports`: named exports, default export, re-exports
  - `functions`: name, signature, params, return type, async/generator flags
- **Caching**: MD5-based cache so unchanged files skip re-parse

### Enrichment (`src/core/enrich.js`)
After parsing, files are enriched with:
- **env_vars**: Detects `process.env.X`, `import.meta.env.X`, `Deno.env.get()`
- **tags**: `api-client`, `browser-storage`, `db-client`, `auth`, `routing`, `side-effect-hook`
- **route**: Next.js route mapping (app/ and pages/ routers)
- **transitive_imports/_imported_by**: 2-hop dependency chains

## Phase 2: Mapper (`src/core/mapper.js`)

### Dependency Resolution
- Converts import paths to canonical file paths
- Handles:
  - Relative imports (`./foo`, `../bar`)
  - Bare imports (`lodash` → external package)
  - Index resolution (`./folder` → `./folder/index.js`)
  - Extension resolution (`.js`, `.jsx`, `.ts`, `.tsx`)

### Graph Algorithms
1. **Tarjan SCC** — Detects circular dependencies
2. **Betweenness Centrality** — Ranks files by "bridge" importance (PageRank-style)
3. **Transitive Importance** — Entry points that orchestrate many modules rank higher

### Network Detection
Groups files by strongly connected components → "networks" shown in the UI.

## Phase 3: Summarizer (`src/ai/summarizer.js`)

### Provider Selection
- `heuristic`: Rule-based (no AI, fast, offline)
- `ollama`: Local Ollama daemon (`qwen2.5-coder` default)
- `ollama-cloud`: Cloud-hosted Ollama with bearer auth
- `anthropic`: Claude Haiku 4.5 (fast + cheap)
- `openai`: GPT-4o-mini or compatible
- `openrouter`: Aggregator with free tier options
- `groq`: Fast inference via Groq API
- `local`: GGUF models via `node-llama-cpp` with tier system (low/medium/high)

### Caching
- **File cache**: MD5-based; unchanged files skip re-summarization
- **Atomic writes**: `map.json.tmp` → `rename` to prevent corruption on SIGINT
- **Serialized writes**: Promise queue prevents concurrent write races

### Concurrency
- **Cloud**: Fixed parallelism (respects rate limits)
- **Ollama**: Defaults to 1 (matches `OLLAMA_NUM_PARALLEL=1` daemon default)
- **Local**: RAM-based auto-scaling (leave 2GB headroom)

### Prompt Strategy
- **File descriptions**: 4-6 sentence technical summaries
- **Function descriptions**: Intentionally empty (reduces token cost)
- **Context window**: AGENTS.md content attached when provider ctx > 4K tokens

## Phase 4: Server (`src/server/server.js`)

### 3D Visualization
- **Force-directed graph** using 3d-force-graph (D3-force-3d)
- **Nodes**: Files as spheres, sized by importance score; packages in green
- **Links**: Dependencies as lines, colored by type (direct vs indirect)
- **Controls**: Orbit/Fly camera modes, physics presets (relaxed/standard/tight)

### API Endpoints
- `GET /api/health` — Health check
- `GET /api/graph` — Full map.json
- `GET /api/search?q=...` — Fuzzy file/function/package search
- `GET /api/node/:id` — Single node details with connections

## Configuration (`src/ai/config.js`)

### Locations
- Repo-level: `<repo>/.reporose/config.json`
- User-level: `~/.reporose/config.json` (presets, global defaults)

### Schema
```json
{
  "ai": {
    "provider": "ollama-cloud",
    "ollama-cloud": {
      "base_url": "https://ollama.com",
      "model": "gpt-oss:20b-cloud",
      "api_key_env": "OLLAMA_API_KEY",
      "options": { "num_ctx": 32000 }
    }
  }
}
```

## Security (`src/utils/secrets.js`)

API keys are stored with **OS keychain** preference, JSON-file fallback:
1. `keytar` → macOS Keychain / Linux libsecret / Windows Credential Vault
2. `~/.reporose/secrets.json` (chmod 0600) as fallback

Keys are injected into `process.env` for the current run and persisted for future runs.

## AGENTS.md (`src/utils/agents-md.js`)

On first run, creates/injects a preamble:
```markdown
<!-- reporose:start -->
> **AI agents:** read `.reporose/map.json` for the full file map...
<!-- reporose:end -->
```

The marker prevents duplicate injections. User content is never modified outside the markers.

## MCP Integration (`src/mcp/server.js`)

Stdio-based MCP server for Claude Desktop / Cursor:
- **Tools**: `reporose_analyze`, `reporose_get_map`, `reporose_search_files`, `reporose_get_file`, `reporose_get_dependencies`
- **Resources**: `reporose://<repo>/map.json`, `reporose://<repo>/AGENTS.md`

## Design Decisions

### Why keep function descriptions empty?
Reduces token usage by ~80%. File-level summaries give the AI sufficient context for most queries. Functions are still in the map for structural analysis.

### Why Ollama Cloud as default?
- Generous free tier
- Same `/api/chat` protocol as local Ollama
- No cold-start vs cloud APIs
- gpt-oss:20b is optimized for code

### Why not extract TypeScript types fully?
Babel-only extraction would miss type imports, declaration merging, and generics. Would produce misleading "shapes". The AI can read the file directly when it needs type info.

### Why transitive imports depth=2?
Depth 3+ explodes map size (O(n²) risk). Depth 2 captures "friend" relationships without overwhelming the JSON.

## Testing

```bash
npm test                    # Run all tests
node --test tests/*.test.js # Node native test runner
```

Test categories:
- `phase1.test.js` — Scanner parsing accuracy
- `phase2.test.js` — Mapper graph algorithms
- `phase3.test.js` — Caching + summarization logic
- `phase5.test.js` — CLI commands + presets
- `phase6.test.js` — New providers (Anthropic, Ollama Cloud, Local tiers)
- `ratelimit.test.js` — Rate limiting (Groq)
- `terminal.test.js` — Terminal UI components
