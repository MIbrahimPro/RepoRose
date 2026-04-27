# AI Providers

## What I Tested

I had access to these providers during development, so they actually work:

- **Ollama Cloud** — tested, works great
- **Ollama Local** — tested, works great  
- **Groq** — tested, works great (uses OpenAI-compatible endpoint)

## What I Didn't Test

The rest of the providers are basically AI-generated code:

- **OpenAI** — *never tested*
- **OpenRouter** — *never tested*
- **Anthropic** — *never tested*
- **Local (node-llama-cpp)** — *never tested*

If you use any of these untested ones and they work, please mention it here so I can update this file.

## Heuristic

This one doesn't need testing — it's just rule-based pattern matching, no AI involved. Works offline.

## Note on Code Quality

Most of the provider implementations are AI-generated because I didn't have API keys or hardware to test them. If something breaks, the fix is probably straightforward but you'll need to debug it yourself.
