# RepoRose Sample Projects Guide

This document shows how to run RepoRose on the example test projects with different configurations.
For the full end-user flow, including running RepoRose outside this repository,
see [`docs/usage.md`](./usage.md).

## Prerequisites

- RepoRose linked globally (run `npm link` from the repo root) — see
  [`docs/install.md`](./install.md).
- For AI providers: appropriate API keys or local models configured. The
  fastest way to set those up is the interactive wizard:

  ```bash
  reporose init test-projects/vercel-commerce
  ```

  Everything below is the equivalent **non-interactive** form, useful for
  scripting and for understanding what `init` writes under the hood.

## Test Projects Directory

All sample projects are located in `test-projects/`:

- `vercel-commerce` - 78 files (smallest, good for quick tests)
- `express` - Medium size
- `excalidraw` - 1,226 files (large)
- `ghost` - Large
- `payload` - Large
- `cal-com` - Large
- `n8n` - Large

## Quick Start (No AI - Fastest)

Run analysis without AI summarization (Phase 1+2 only):

```bash
# Analyze without AI descriptions
reporose analyze test-projects/vercel-commerce --no-summarize

# Visualize the results
reporose serve test-projects/vercel-commerce
```

This runs in ~5-10 seconds and opens a browser at `http://127.0.0.1:8689`.

## Full Analysis with AI

### Using Heuristic Provider (Offline, Rule-Based)

```bash
reporose analyze test-projects/vercel-commerce
reporose serve test-projects/vercel-commerce
```

The heuristic provider generates descriptions based on file patterns, exports, and function signatures. No API keys required.

### Using Ollama (Local Models)

First, ensure Ollama is running:
```bash
ollama serve
```

Pull the model:
```bash
ollama pull qwen2.5-coder:3b-instruct-q4_K_M
```

Configure and run:
```bash
# Configure for Ollama with your specific parameters
reporose config test-projects/vercel-commerce \
  --model ollama \
  --ollama-model qwen2.5-coder:3b-instruct-q4_K_M \
  --num-ctx 32000 \
  --temperature 0 \
  --num-predict 10000

# Run analysis (expect ~25-30 minutes for vercel-commerce due to ~5-7 tok/sec)
reporose analyze test-projects/vercel-commerce

# Visualize
reporose serve test-projects/vercel-commerce
```

**Note**: Ollama is CPU-bound and slow (~5-7 tokens/sec). For faster results, use cloud providers.

### Using OpenAI (Cloud)

Set your API key:
```bash
export OPENAI_API_KEY=your-key-here
```

Configure and run:
```bash
reporose config test-projects/vercel-commerce \
  --model openai \
  --model-name gpt-4o-mini

reporose analyze test-projects/vercel-commerce
reporose serve test-projects/vercel-commerce
```

### Using OpenRouter (Cloud)

Set your API key:
```bash
export OPENROUTER_API_KEY=your-key-here
```

Configure and run:
```bash
reporose config test-projects/vercel-commerce \
  --model openrouter \
  --model-name meta-llama/llama-3.2-3b-instruct:free

reporose analyze test-projects/vercel-commerce
reporose serve test-projects/vercel-commerce
```

### Using Local GGUF Models (node-llama-cpp)

```bash
reporose config test-projects/vercel-commerce \
  --model local \
  --model-path /path/to/model.gguf

reporose analyze test-projects/vercel-commerce
reporose serve test-projects/vercel-commerce
```

### Skip AI Descriptions Entirely

```bash
reporose config test-projects/vercel-commerce --model none
reporose analyze test-projects/vercel-commerce
reporose serve test-projects/vercel-commerce
```

All files and functions will have empty descriptions, but Phase 1+2 (scanning and dependency mapping) still runs.

## Using Presets

Save a configuration as a preset and reuse it across projects:

```bash
# Save current configuration as a preset
reporose preset save my-ollama-setup test-projects/vercel-commerce

# List all presets
reporose preset list

# Apply a preset to another project
reporose preset use my-ollama-setup test-projects/express

# Show a preset's details
reporose preset show my-ollama-setup

# Delete a preset
reporose preset delete my-ollama-setup
```

Presets are stored in `~/.reporose/presets.json`.

## Phase-by-Phase Execution

Run individual phases separately:

```bash
# Phase 1: Scan only (no dependencies, no AI)
reporose analyze test-projects/vercel-commerce --no-map --no-summarize

# Phase 2: Dependency mapping only (requires Phase 1 output)
reporose map test-projects/vercel-commerce

# Phase 3: AI summarization only (requires Phase 1+2 output)
reporose summarize test-projects/vercel-commerce

# Phase 4: Visualization (requires map.json)
reporose serve test-projects/vercel-commerce
```

## Visualization Options

Customize the web server:

```bash
# Use a different port
reporose serve test-projects/vercel-commerce --port 3000

# Bind to all interfaces (not just localhost)
reporose serve test-projects/vercel-commerce --host 0.0.0.0

# Don't auto-open browser
reporose serve test-projects/vercel-commerce --no-open

# Suppress request logs
reporose serve test-projects/vercel-commerce --silent
```

## Output Directory Control

By default, output goes to `<repo>/.reporose/`. Customize:

```bash
reporose analyze test-projects/vercel-commerce --out .reporose-custom
reporose serve test-projects/vercel-commerce --out .reporose-custom
```

## Caching Behavior

AI descriptions are cached by file hash. Re-running on unchanged files is instant:

```bash
# First run: generates descriptions (slow with AI)
reporose analyze test-projects/vercel-commerce

# Second run: uses cached descriptions (fast)
reporose analyze test-projects/vercel-commerce

# Force re-generation: delete cache
rm -rf test-projects/vercel-commerce/.reporose/cache/
reporose analyze test-projects/vercel-commerce
```

## Configuration Management

View current configuration:

```bash
reporose config test-projects/vercel-commerce --show
```

Output example:
```
provider:                ollama
model label:             qwen2.5-coder:3b-instruct-q4_K_M
ollama.base_url:         http://localhost:11434
ollama.model:            qwen2.5-coder:3b-instruct-q4_K_M
ollama.options:          {"num_ctx":32000,"temperature":0,"num_predict":10000}
```

## Provider-Specific Options

### Ollama Options

```bash
reporose config test-projects/vercel-commerce \
  --ollama-url http://localhost:11434 \
  --ollama-model qwen2.5-coder:3b-instruct-q4_K_M \
  --num-ctx 32000 \
  --temperature 0 \
  --num-predict 10000
```

- `--num-ctx`: Context window size (tokens)
- `--temperature`: Sampling temperature (0 = deterministic, higher = more creative)
- `--num-predict`: Maximum output tokens

### OpenAI-Compatible Options

```bash
reporose config test-projects/vercel-commerce \
  --base-url https://api.openai.com/v1 \
  --model-name gpt-4o-mini \
  --api-key-env OPENAI_API_KEY
```

Works with any OpenAI-compatible endpoint:
- OpenAI (`https://api.openai.com/v1`)
- Together AI (`https://api.together.xyz/v1`)
- Groq (`https://api.groq.com/openai/v1`)
- Deepseek (`https://api.deepseek.com/v1`)
- Local servers (LM Studio, Ollama OpenAI-compat shim)

## Error Handling

If a configured provider fails (Ollama unreachable, missing API key, etc.):

- RepoRose skips Phase 3 with a warning and leaves descriptions empty
- This prevents silent downgrades — you know when your AI isn't working

To see warnings:
```bash
reporose analyze test-projects/vercel-commerce
```

Example warning:
```
[reporose] warn: Ollama unreachable: Cannot reach Ollama at http://localhost:11434. Skipping Phase 3.
```

## Performance Notes

| Provider      | Speed (approx) | Cost         | Notes                          |
|---------------|----------------|--------------|--------------------------------|
| heuristic     | Instant        | Free         | Rule-based, offline             |
| none          | Instant        | Free         | Empty descriptions              |
| ollama        | 5-7 tok/sec    | Free (local) | CPU-bound, slow                 |
| ollama-cloud  | Fast           | Free tier    | Cloud Ollama, generous limits   |
| openai        | Fast           | Paid         | ~$0.001-0.01 per file           |
| anthropic     | Fast           | Paid         | Claude Haiku, fast + cheap      |
| openrouter    | Fast           | Paid         | Free tier available             |
| local (GGUF)  | Variable       | Free         | GPU-dependent                   |

## Example Workflows

### Workflow 1: Quick Exploration (No AI)

```bash
# Fast scan and visualize
reporose analyze test-projects/express --no-summarize
reporose serve test-projects/express
```

### Workflow 2: Full Analysis with Ollama

```bash
# Configure once
reporose preset save ollama-qwen test-projects/vercel-commerce

# Apply to multiple projects
reporose preset use ollama-qwen test-projects/express
reporose analyze test-projects/express
reporose serve test-projects/express

reporose preset use ollama-qwen test-projects/excalidraw
reporose analyze test-projects/excalidraw
reporose serve test-projects/excalidraw
```

### Workflow 3: Cloud Provider for Speed

```bash
# Use OpenAI for fast results
export OPENAI_API_KEY=your-key
reporose config test-projects/vercel-commerce --model openai --model-name gpt-4o-mini
reporose analyze test-projects/vercel-commerce
reporose serve test-projects/vercel-commerce
```

### Workflow 4: Iterative Development

```bash
# Scan without AI to get the structure
reporose analyze test-projects/vercel-commerce --no-summarize

# Explore the structure
reporose serve test-projects/vercel-commerce

# When ready, add AI descriptions
reporose summarize test-projects/vercel-commerce

# Re-visualize with descriptions
reporose serve test-projects/vercel-commerce
```

## Help

Get command help:

```bash
reporose help
```

Get specific command help:
```bash
reporose analyze --help
reporose serve --help
reporose config --help
reporose preset --help
```
