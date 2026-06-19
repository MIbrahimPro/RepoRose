# RepoRose Usage Guide

This is the complete practical guide for using RepoRose as a normal CLI tool.

## Correct command name

The command is:

```bash
reporose
```

Not `reposose`.

Verify it is installed:

```bash
which reporose
reporose help
```

If `which reporose` prints nothing, install/link it first from the RepoRose source folder:

```bash
cd /home/mibrahimpro/Documents/reporose
npm install
npm link
```

After that, `reporose` works from **any folder**, not only from the RepoRose repo.

## Mental model: analyze vs serve

RepoRose has two separate steps:

```bash
reporose analyze   # scans code and writes .reporose/map.json
reporose serve     # opens the browser visualization for an existing map.json
```

Important:

- `reporose analyze` creates or updates `<project>/.reporose/map.json`.
- `reporose serve` does **not** scan code. It only serves an existing map.
- If you run `serve` before `analyze`, RepoRose will not have a map to display.

## Quick test inside one of the bundled projects

From the RepoRose repo:

```bash
cd /home/mibrahimpro/Documents/reporose/test-projects/vercel-commerce
reporose analyze --no-summarize
reporose serve
```

Open the URL printed by the command, usually:

```text
http://127.0.0.1:8689
```

Stop the server with `Ctrl+C`.

If port `8689` is already used, RepoRose automatically picks the next one, e.g. `8690`. Use the exact URL printed in your terminal.

## Test on `cal-com`

`cal-com` is large, so first test without AI:

```bash
cd /home/mibrahimpro/Documents/reporose/test-projects/cal-com
reporose analyze --no-summarize
reporose serve
```

Expected output looks like:

```text
[reporose] Server listening on http://127.0.0.1:8690
[reporose] Serving map from /home/.../test-projects/cal-com/.reporose/map.json
```

Open that exact URL in the browser.

## Test on a repo outside the RepoRose folder

This is the real end-user flow.

```bash
mkdir -p ~/code/reporose-playground
cd ~/code/reporose-playground

git clone --depth 1 https://github.com/sindresorhus/is.git
cd is

reporose analyze --no-summarize
reporose serve
```

Then open the printed URL.

You can replace the repo with any GitHub project:

```bash
mkdir -p ~/code/reporose-playground
cd ~/code/reporose-playground

git clone --depth 1 https://github.com/vercel/commerce.git
cd commerce

reporose init
reporose analyze
reporose serve
```

## Interactive setup wizard

For normal users, this is the easiest path:

```bash
cd /path/to/any/project
reporose init
```

It asks what kind of descriptions you want:

1. heuristic — Rule-based offline descriptions
2. ollama — Local Ollama AI
3. openai — OpenAI-compatible API
4. openrouter — OpenRouter aggregator
5. local — Local GGUF model (node-llama-cpp)
6. none — No AI descriptions
7. anthropic — Claude Haiku 4.5
8. ollama-cloud — Cloud Ollama (free tier)

After setup:

```bash
reporose analyze
reporose serve
```

## AI-free mode

Fastest mode, best for testing visualization:

```bash
reporose config --model none
reporose analyze
reporose serve
```

This scans the repo and builds the dependency map, but leaves descriptions empty.

## Offline rule-based descriptions

Fast, no API key:

```bash
reporose config --model heuristic
reporose analyze
reporose serve
```

## Ollama descriptions

If Ollama is already running:

```bash
ollama pull qwen2.5-coder:3b-instruct-q4_K_M

reporose config --model ollama \
  --ollama-model qwen2.5-coder:3b-instruct-q4_K_M \
  --num-ctx 32000 \
  --temperature 0 \
  --num-predict 10000

reporose analyze
reporose serve
```

## Ollama Cloud descriptions (easiest free option)

Get a free API key from ollama.com:

```bash
export OLLAMA_API_KEY=your-key
reporose config --model ollama-cloud
reporose analyze
reporose serve
```

If `ollama serve` says:

```text
bind: address already in use
```

that usually means Ollama is **already running**. That is fine. Check it with:

```bash
curl http://localhost:11434/api/tags
```

## OpenAI descriptions

```bash
export OPENAI_API_KEY=your-key
reporose config --model openai --model-name gpt-4o-mini
reporose analyze
reporose serve
```

You can also put the key in a project `.env` file:

```bash
echo 'OPENAI_API_KEY=your-key' > .env
```

## OpenRouter descriptions

```bash
export OPENROUTER_API_KEY=your-key
reporose config --model openrouter \
  --model-name meta-llama/llama-3.2-3b-instruct:free
reporose analyze
reporose serve
```

## Anthropic (Claude) descriptions

```bash
export ANTHROPIC_API_KEY=your-key
reporose config --model anthropic
reporose analyze
reporose serve
```

## Presets

Save a setup:

```bash
reporose preset save my-setup
```

Use it in another project:

```bash
cd /path/to/another/project
reporose preset use my-setup
reporose analyze
reporose serve
```

List presets:

```bash
reporose preset list
```

## Visualization controls

- Drag mouse: rotate view
- Mouse wheel: zoom
- `◎` button in the top-right: fit graph in view
- Search bar: search files/functions/packages
- Settings gear: switch camera mode, limit edges, toggle arrows
- Network selector in the Physics panel: switch between disconnected networks/components
- Previous/Next buttons: move through each separate disconnected network
- Click a node: open details panel
- `Esc`: close panels
- `?`: keyboard help

## If the page is blank

Use this checklist in order:

### 1. Confirm you are on the printed port

If terminal says:

```text
Server listening on http://127.0.0.1:8690
```

open `http://127.0.0.1:8690`, not `8689`.

### 2. Hard-refresh browser cache

Press:

```text
Ctrl+Shift+R
```

The frontend is static JavaScript, so the browser can cache an old `app.js`.

### 3. Confirm overlays are hidden

If DevTools shows these elements with `hidden=""`, they should not cover the page:

```html
<div id="loading" class="overlay" hidden="">
<div id="error" class="overlay" hidden="">
```

RepoRose CSS includes:

```css
[hidden] { display: none !important; }
```

If you do not see that CSS rule in DevTools, restart `reporose serve` and hard-refresh.

### 4. Click the fit button

Click the `◎` button in the top-right. Large graphs can start outside the camera view while layout settles.

### 5. Check that a map exists

From the project folder:

```bash
ls -lh .reporose/map.json
```

If it does not exist:

```bash
reporose analyze --no-summarize
reporose serve
```

### 6. Check the graph API

While `reporose serve` is running, open another terminal in the same project and run:

```bash
curl http://127.0.0.1:8690/api/health
curl http://127.0.0.1:8690/api/graph | head
```

Use your actual port. You should see JSON.

### 7. Check browser console

Open DevTools with `F12`, then Console. If you see an error, copy it exactly.

## Clean reset for a project

Delete RepoRose output and run again:

```bash
rm -rf .reporose
reporose analyze --no-summarize
reporose serve
```

## Full clean external demo

Copy-paste this into a terminal:

```bash
mkdir -p ~/code/reporose-demo
cd ~/code/reporose-demo
rm -rf is

git clone --depth 1 https://github.com/sindresorhus/is.git
cd is

reporose analyze --no-summarize
reporose serve
```

That proves RepoRose works outside `/home/mibrahimpro/Documents/reporose`.
