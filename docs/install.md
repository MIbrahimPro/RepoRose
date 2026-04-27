# Installing & Using RepoRose

This guide is for **end users** who just want to run RepoRose on their own
projects. You do not need to be a JavaScript developer.

## What you need

- **Node.js v18 or newer** — get it from <https://nodejs.org> or via your
  package manager (`brew install node`, `apt install nodejs npm`, etc.)
- That is it. Everything else is optional.

## Install (one-time)

### Option A — install globally from the repo (current recommended path)

```bash
git clone https://github.com/MIbrahimPro/RepoRose.git
cd RepoRose
npm install
npm link        # makes the `reporose` command available system-wide
```

After this, `reporose` works from any folder on your machine. If you ever
want to remove it: `npm unlink -g reporose`.

### Option B — run without installing (no `npm link`)

If you do not want to add `reporose` to your `PATH`:

```bash
git clone https://github.com/MIbrahimPro/RepoRose.git
cd RepoRose
npm install
node bin/cli.js <command>     # use this everywhere instead of `reporose <command>`
```

### Option C — once it is published to npm (future)

```bash
npm install -g reporose
```

## First run — the interactive wizard

The fastest way to get started:

```bash
cd /path/to/the/project/you/want/to/visualize
reporose init
```

You will be walked through a short menu:

```
Which AI provider?
  1) heuristic    — Rule-based (offline), fast, no setup
  2) ollama      — Local Ollama, free, runs on your machine
  3) openai      — OpenAI-compatible APIs (GPT-4, etc)
  4) openrouter  — Free + paid models aggregator
  5) local       — Local GGUF via node-llama-cpp
  6) none        — No AI descriptions, just the graph
  7) anthropic   — Claude Haiku 4.5 (fast + cheap)
  8) ollama-cloud — Cloud Ollama, free tier available
```

Pick whichever fits you. The wizard will:

- For **Ollama / Ollama Cloud**: check whether `ollama` is installed (local only),
  offer to install it on Linux, verify the daemon is running, list installed models,
  suggest appropriate models, and offer to pull them for you.
- For **OpenAI / OpenRouter / Anthropic**: ask for the env-var name that holds your API
  key and the model name. If the env var is not set yet you will see a reminder to
  `export` it before running `reporose analyze`.
- For **Local GGUF**: ask for the absolute path to a `.gguf` file and pick a tier (low/medium/high).
- For **Heuristic** or **None**: nothing extra — just save the config.

At the end you can:

- Save the choice as a **preset** so other projects can re-use it with
  `reporose preset use <name>`.
- **Run `reporose analyze` immediately** if you want to go straight to the
  visualization.

## Day-to-day commands

```bash
# 1. Scan + map + (optionally) describe — writes <repo>/.reporose/map.json
reporose analyze

# 2. Open the 3D visualization in your browser
reporose serve
```

That is the whole workflow.  Both commands default to the current directory,
so `cd` into the project first or pass the path: `reporose analyze /path/to/repo`.

## When AI is configured but does not work

If you picked Ollama and the daemon is down, or your API key is missing,
RepoRose will **skip Phase 3** with a warning. The dependency map (Phase 1+2)
still gets written, so `reporose serve` still works — you just see empty
descriptions until you fix the provider.

## Switching providers later

```bash
# Re-run the wizard
reporose init

# OR change a single setting non-interactively
reporose config --model openai --model-name gpt-4o-mini
reporose config --model none           # turn AI off
reporose config --show                 # see what is currently configured
```

## Sharing a configuration across projects

Save once, reuse everywhere:

```bash
# In project A — set things up the way you like, then snapshot it.
reporose init
reporose preset save my-setup

# In project B — apply that snapshot.
reporose preset use my-setup
reporose analyze
```

Presets live at `~/.reporose/presets.json` (your home directory).

## Where things are stored

| Location                              | What                         |
|---------------------------------------|------------------------------|
| `<repo>/.reporose/config.json`        | Per-project provider config  |
| `<repo>/.reporose/map.json`           | The scan result (Phase 1+2+3)|
| `<repo>/.reporose/cache/summaries.json`| AI description cache (per file hash) |
| `~/.reporose/presets.json`            | Your saved presets (global)  |

You can safely delete any of these — they will be regenerated.

## Uninstall

```bash
npm unlink -g reporose         # if you used `npm link`
rm -rf ~/.reporose             # remove your presets (optional)
```

Per-project data lives inside each repo's `.reporose/` folder; delete that
folder if you no longer want RepoRose data for a specific project.
