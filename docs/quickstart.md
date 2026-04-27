# Quickstart — Run RepoRose on a Fresh Repo

This is the **end-user happy path**: you have RepoRose installed, you find a
project on GitHub, and you want to see its 3D map in your browser. Total
time: ~2 minutes for the no-AI path, longer if you want AI descriptions.

## Step 0 — Install RepoRose (one time)

```bash
npm install -g reporose
```

Or if you want the latest dev version:

```bash
git clone https://github.com/MIbrahimPro/RepoRose.git ~/tools/RepoRose
cd ~/tools/RepoRose
npm install
npm link
```

Verify:

```bash
reporose help
```

**MCP Server (optional)** — for Claude Desktop / Cursor integration:

```bash
# Add to your Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json on Mac)
{
  "mcpServers": {
    "reporose": {
      "command": "reporose",
      "args": ["mcp"]
    }
  }
}
```

Then restart Claude Desktop. RepoRose will appear as a tool for analyzing repos.

## Step 1 — Pick a brand-new working folder

Anywhere you like, **outside** of the RepoRose repo:

```bash
mkdir -p ~/code/playground
cd ~/code/playground
```

## Step 2 — `git clone` the project you want to visualize

Pick anything. For a small, fast-to-scan example use Vercel Commerce:

```bash
git clone --depth 1 https://github.com/vercel/commerce.git
cd commerce
```

`--depth 1` skips the full history so the clone is quick.

## Step 3 — Set up RepoRose for this repo

Run the wizard. It picks the AI provider, saves config under
`./.reporose/config.json`, and offers to run analyze immediately:

```bash
reporose init
```

Recommended first answers:

- **Which AI provider?** → `1` (Rule-based / offline) for a 5-second test
  run, or `6` (No AI) if you only care about the dependency graph.
  Or pick `8` (Ollama Cloud) for free cloud AI with no setup.
- Skip the preset prompt for now (`n`).
- **Run analyze now?** → `y`.

If you instead want a fully AI-described map, see Step 6 below.

## Step 4 — (If you skipped step 3's auto-analyze) Run analyze manually

```bash
reporose analyze
```

You should see something like:

```
[reporose] Analyzing /home/<you>/code/playground/commerce
[reporose] Scanned 50 files...
[reporose] Computing dependency map
[reporose] Generating descriptions (provider: heuristic)
[reporose] Analyzed 78 files (1 ignored) in 0.20s
[reporose] Mapped 127 links, 1 cycles, 2 networks
[reporose] Map written to /home/<you>/code/playground/commerce/.reporose/map.json
```

## Step 5 — Open the 3D visualization

```bash
reporose serve
```

Output:

```
[reporose] Server listening on http://127.0.0.1:8689
[reporose] Serving map from /home/<you>/code/playground/commerce/.reporose/map.json
```

It auto-opens your default browser. If it does not, paste the URL in
manually. `Ctrl+C` to stop. Pass `--port 4000` to use a different port,
`--no-open` to suppress the auto-open.

## Step 6 — (Optional) Use real AI for descriptions

The wizard branches above are non-interactive equivalents of these:

### Free, cloud, fast — Ollama Cloud (easiest)

```bash
export OLLAMA_API_KEY=your-key-from-ollama.com
reporose config --model ollama-cloud
reporose analyze
reporose serve
```

### Free, local, slow — Ollama

```bash
# one-time, anywhere:
ollama serve &                                  # daemon
ollama pull qwen2.5-coder:3b-instruct-q4_K_M    # ~2 GB

# for this repo:
reporose config --model ollama \
  --ollama-model qwen2.5-coder:3b-instruct-q4_K_M \
  --num-ctx 32000 --temperature 0 --num-predict 10000
reporose analyze        # ~25-30 min for 78 files at ~5-7 tok/sec
reporose serve
```

### Fast, paid — OpenAI / Anthropic

```bash
# OpenAI
export OPENAI_API_KEY=sk-...
reporose config --model openai --model-name gpt-4o-mini

# Or Anthropic (Claude)
export ANTHROPIC_API_KEY=sk-...
reporose config --model anthropic

reporose analyze
reporose serve
```

### Free tier — OpenRouter

```bash
export OPENROUTER_API_KEY=sk-or-...
reporose config --model openrouter \
  --model-name meta-llama/llama-3.2-3b-instruct:free
reporose analyze
reporose serve
```

## Step 7 — Try a different project

The whole flow is repeatable. From the same parent folder:

```bash
cd ~/code/playground
git clone --depth 1 https://github.com/expressjs/express.git
cd express
reporose init        # or: reporose preset use my-saved-setup
reporose analyze
reporose serve
```

## What gets created (and how to clean up)

For each repo you analyze:

```
<repo>/.reporose/
├── config.json                  # provider settings for this repo
├── map.json                     # the dependency map (used by `serve`)
└── cache/
    └── summaries.json           # AI descriptions, keyed by file hash
```

Deleting `<repo>/.reporose/` reverts that project to a clean state.
Deleting `~/.reporose/presets.json` clears your saved presets.

## What if the visualization is blank?

- Check the browser console (F12). RepoRose prints any startup error there.
- Hard-refresh (Ctrl+Shift+R) to bypass the cached `app.js`.
- Make sure `reporose analyze` actually wrote `<repo>/.reporose/map.json`.
- Try `reporose serve --port 4000` if 8689 is already taken.

## What if a script in the cloned repo runs instead of RepoRose?

`reporose` is a separate global CLI — it does **not** read the cloned
repo's `package.json` scripts. You can run `reporose` from inside any
folder that contains source code; it just looks for files to scan, plus
its own `.reporose/` config folder.

If you want a colleague who has never seen RepoRose to repeat what you
did, the entire instruction set is:

```bash
# 1. install once
git clone https://github.com/MIbrahimPro/RepoRose.git ~/tools/RepoRose
cd ~/tools/RepoRose && npm install && npm link

# 2. for each repo
git clone --depth 1 <repo-url>
cd <repo-name>
reporose init        # answer the prompts
reporose serve       # browser opens automatically
```

That is the whole user experience.
