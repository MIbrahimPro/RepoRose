# Contributing to Reporose

Thank you for considering contributing to Reporose! This document outlines the process and guidelines.

## Quick Links

- [Architecture Overview](docs/logics.md) — How the code works
- [README](README.md) — User-facing documentation

## Getting Started

### Prerequisites
- Node.js 18+ (native `fetch` required)
- npm or yarn

### Setup
```bash
git clone https://github.com/MIbrahimPro/RepoRose.git
cd RepoRose
npm install
npm test
```

## Development Workflow

### 1. Create a Branch
```bash
git checkout -b feature/your-feature-name
```

### 2. Make Changes
- Follow existing code style
- Add/update tests for new functionality (if needed)
- Run existing tests and verify they pass: `npm test`
- Update documentation if user-facing behavior changes

### 3. Test
```bash
npm test                    # All tests must pass
npm run analyze -- <path>   # Manual integration test
```

### 4. Commit
We follow [Conventional Commits](https://www.conventionalcommits.org/):
```
feat: add new behavior tag for web sockets
fix: handle optional chaining in parser
docs: update README with new provider
refactor: simplify transitive import logic
test: add coverage for ollama installer
```

### 5. Pull Request
- Reference any related issues
- Keep changes focused (one concern per PR)
- Ensure CI passes

## Code Style

- **Be real in comments** - Write comments that explain what the code does, in plain language, 
- **Using AI is not a Shame** - If you used AI, just say it,, but still explain what the function does. Just ask the AI what it does and put it there.
- **Indentation**: Use consistent indentation (2 spaces)
- **Spacing**: Leave 10-15 blank lines between major code sections to improve readability and separate what each portion does
- **No pretense** - Write code that's easy to understand, not clever for the sake of being clever, It should just work. (yes,, can be smart,,, but you need to explain it, using comments,, which should not be boring to read)

**Your pull request WILL get rejected if your code is hard to understand**

### Example
```javascript
// Prefer early returns
async function analyze(path, opts) {
  if (!fs.existsSync(path)) {
    throw new Error(`Path not found: ${path}`);
  }
  // ... main logic
}

// Use destructuring
function configure({ baseUrl, apiKey, model }) {
  // ...
}
```

## Testing Requirements

### Must Have Tests
- New AI providers
- CLI commands/flags
- Config schema changes
- Enrichment algorithms

### Test Structure
```javascript
const test = require('node:test');
const assert = require('node:assert/strict');

test('feature does X when Y', async () => {
  const result = await featureUnderTest(input);
  assert.equal(result.expected, 'value');
});
```

### Mocking HTTP
Use the in-process mock server pattern (see `tests/phase5.test.js`):
```javascript
const { server, url } = await startMockServer((req, res) => {
  res.end(JSON.stringify({ mock: 'response' }));
});
// ... test with url
server.close();
```

## Documentation Requirements

Update docs when:
- Adding/modifying CLI commands
- Changing config schema
- Adding new providers
- Modifying default behavior

Files to update:
- `README.md` — User-facing usage
- `docs/logics.md` — Architecture details
- `CHANGELOG.md` — Release notes

## Provider Guidelines

Adding a new AI provider? Follow this checklist:

- [ ] Create `src/ai/<provider>.js`
- [ ] Export `create<Provider>Provider` function
- [ ] Support streaming via `onStream` callback
- [ ] Handle rate limits with `retry-after` parsing
- [ ] Add to `KNOWN_PROVIDERS` in `src/ai/config.js`
- [ ] Add default model + config schema
- [ ] Add init wizard branch in `src/cli/init.js`
- [ ] Add HTTP fixtures test
- [ ] Update README with provider-specific setup

## Release Process

1. Update `CHANGELOG.md`
2. Bump version in `package.json`
3. Tag: `git tag -a v0.x.x -m "Release v0.x.x"`
4. Push tags: `git push --follow-tags`
5. `npm publish` (maintainers only)

## Code of Conduct

- **Be real, not professional** - Write like a human, not a corporate handbook
- Comment what your code does - Don't assume it's self-explanatory
- Be respectful and constructive
- Focus on the technical merit of contributions
- Help newcomers learn the codebase

## Questions?

- Open an issue for bugs or feature requests
- Check existing issues/PRs before creating new ones

## License

By contributing, you agree that your contributions will be licensed under the GPL-3.0 License.

**What this means:**
- You can fork, modify, and use this project commercially
- You must keep your fork open source
- You must credit the original project
- You must release your modifications under the same license
