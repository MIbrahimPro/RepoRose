# Tests

## Disclaimer

I am a developer, not a tester. I never wrote a test in my life—which is still true because all of these are written by AI.

If you also haven't done testing, I prefer doing something similar. Just let the AI handle it and pretend you know what's going on.

If you're an actual tester though—rare find. Please read these tests and IDK, improve them or whatever. See if they're actually useful. Maybe write more. Do what you want.

Why are you reading this anyways?


## Are the tests good?

Honestly? No idea. They seem to pass. The AI says they're comprehensive. I just nod and smile.

If you find a bug that the tests didn't catch—well, that's why we have users, right?

# This part under is by AI,,, it was insisting so I let him write this
## What's in here

The tests are organized by "phases" which match the phases of reporose operation:

- **phase1.test.js** — Scanner tests (parsing files, extracting imports/exports/functions)
- **phase2.test.js** — Mapper tests (dependency graph, circular detection, importance scores)
- **phase3.test.js** — Summarizer tests (AI providers, caching, concurrency)
- **phase4.test.js** — Server tests (API endpoints, search, static files)
- **phase5.test.js** — CLI tests (commands, init wizard, config)
- **phase6.test.js** — New provider tests (Anthropic, Ollama Cloud, Local tiers)

Plus some extras:
- **mapper-extras.test.js** — Additional mapper edge cases
- **scanner-extras.test.js** — Additional scanner edge cases
- **ratelimit.test.js** — Rate limiting tests (mostly for Groq)
- **terminal.test.js** — Terminal UI tests (progress bars, spinners)

## Running tests

```bash
npm test
```

Or run a specific phase:

```bash
node --test tests/phase1.test.js
```