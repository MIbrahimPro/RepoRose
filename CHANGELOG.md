# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-27

### Added

- **v0.1.0 Initial Release**
- Auto-init: `reporose analyze` and `reporose serve` now run the init wizard inline when no config exists
- `--reset` flag: Clear cache and map.json to re-analyze from scratch
- License  GPL-3.0 (copyleft - forks must remain open source, commercial use allowed with attribution)
- `--yes` / `-y` flag: Accept all prompts non-interactively (CI-friendly)
- `--no-auto-init` flag: Opt out of automatic wizard
- **Secrets management**: Secure API key storage via OS keychain (macOS Keychain, Linux libsecret, Windows Credential Vault) with JSON-file fallback
- Hidden password input during init wizard for API keys
- **Ollama installer**: Confirm-then-install for local Ollama (Linux/macOS/Windows) with progress feedback
- **Ollama Cloud as default**: New provider with curated model list (gpt-oss:20b-cloud recommended)
- **Anthropic Claude provider**: Messages API support with claude-haiku-4-5 default
- **Local provider tiers**: Low/Medium/High hardware presets for context size and GPU layers
- **AGENTS.md preamble**: Auto-creates or injects marker block directing AI to read map.json
- **MCP server**: `reporose mcp` exposes stdio server for Claude Desktop/Cursor integration
  - Tools: `reporose_analyze`, `reporose_get_map`, `reporose_search_files`, `reporose_get_file`, `reporose_get_dependencies`
  - Resources: `reporose://map/<repo>`, `reporose://agents/<repo>`
- **map.json enrichments**:
  - Environment variable detection (process.env, import.meta.env, Deno.env, Bun.env)
  - Behavior tags: api-client, browser-storage, side-effect-hook, db-client, auth, routing
  - Next.js route mapping (app/ and pages/ routers)
  - Transitive imports/exports (depth ≤ 2)
- Update notifier: Warns when a newer npm version is available (disabled via `REPOROSE_NO_UPDATE_CHECK=1`)
- First-run latency warnings for cloud providers and model downloads
- Documentation: `docs/logics.md`, `CONTRIBUTING.md`

### Changed

- Version bumped from 0.0.1 to 0.1.0 (pre-1.0 semver)
- Provider menu now shows 8 options with Ollama Cloud as default
- CLI UX: Mid-run options panel for skip-summarize, reset when interactive

### Fixed

- Ollama cloud installs skip model membership check (cloud /api/tags returns user models only)
- AGENTS.md context only attached when provider context window is large enough

## [0.0.1] - 2026-04-25

### Added

- Initial prototype with heuristic provider, Ollama local, OpenAI/OpenRouter
- Dependency mapping with circular detection
- 3D visualization server
- Caching and incremental persistence
