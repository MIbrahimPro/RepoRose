# RepoRose Test Guide

This document describes how to run the RepoRose test suite.

## Prerequisites

- Node.js v18+ installed
- RepoRose linked globally (run `npm link` from the repo root)

## Run All Tests

Run the complete test suite:

```bash
npm test
```

This runs all test files in the `tests/` directory using Node.js's built-in test runner.

## Test Coverage

The test suite covers:

- **Phase 1** (Scanner): Repository scanning, AST parsing, imports/exports/functions
- **Phase 2** (Mapper): Dependency mapping, circular detection, importance scores
- **Phase 3** (AI Summarization): Provider selection, caching, retry logic, concurrency
- **Phase 4** (Web Server): API endpoints, search functionality, static file serving
- **Phase 5** (CLI & Presets): Commands, init wizard, config management
- **Phase 6** (New Providers): Anthropic, Ollama Cloud, Local tiers, AGENTS.md context

## Test Files

- `tests/phase1.test.js` - Core scanner functionality (file parsing, AST handling)
- `tests/phase2.test.js` - Dependency mapping and statistics
- `tests/phase3.test.js` - AI summarization, caching, provider selection, retry logic
- `tests/phase4.test.js` - Web server API, search, static serving
- `tests/phase5.test.js` - CLI commands, presets, config management
- `tests/phase6.test.js` - New providers (Anthropic, Ollama Cloud, Local tiers)
- `tests/scanner-extras.test.js` - Additional scanner edge cases
- `tests/mapper-extras.test.js` - Additional mapper edge cases
- `tests/ratelimit.test.js` - Rate limiting for Groq provider
- `tests/terminal.test.js` - Terminal UI (progress bars, spinners)

## Run Specific Test File

```bash
node --test tests/phase3.test.js
node --test tests/phase5.test.js
```

## Run Tests with Verbose Output

Node's built-in test runner uses `--test-reporter` for output formatting:

```bash
# Detailed spec-style output
node --test --test-reporter=spec tests/*.test.js

# TAP output (the default)
node --test tests/*.test.js

# JUnit XML (good for CI)
node --test --test-reporter=junit tests/*.test.js > junit.xml
```

## Expected Results

All tests should pass with output similar to:

```
ℹ tests 146
ℹ suites 0
ℹ pass 146
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms ~2000
```

## Test Behavior Notes

- **Provider failure tests**: Tests that verify provider unreachability (Ollama down, missing API keys) are mocked and do not require real API access
- **Preset tests**: Use a sandboxed `$HOME`/`$USERPROFILE` to avoid affecting your actual presets
- **Server tests**: Use a dynamically allocated port to avoid conflicts

## Troubleshooting

**Tests fail with "MODULE_NOT_FOUND"**:
- Ensure you're in the RepoRose repository root
- Run `npm install` to install dependencies

**Tests fail with "EADDRINUSE"**:
- The server tests try to find an available port automatically
- If port 8689 is in use, tests will try alternative ports

**Tests timeout**:
- Check that no long-running processes are blocking
- Ensure sufficient system resources
