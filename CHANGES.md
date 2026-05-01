# Reporose v0.2.0 Changes

## Summary of Major Changes

### 1. Split Storage System (index + files/)
Instead of one massive `map.json`, Reporose now uses split storage:
- `.reporose/index.json` - Lightweight metadata, file list with brief descriptions, packages, links, statistics
- `.reporose/files/*.json` - Individual file records with full descriptions, tags, functions, imports, exports

**Benefits:**
- AI agents can read just the index (KBs) instead of the full map (MBs)
- Individual file lookups are fast
- Partial updates don't rewrite the entire map

### 2. AI Pre-Filtering
Before summarizing files, Reporose now asks the AI to identify which files should be summarized:
- Skips auto-generated files (lock files, build output)
- Skips test fixtures and mock data
- Skips temporary/minified files
- Uses heuristics as fallback if AI is unavailable

**Benefit:** Saves tokens by not summarizing useless files

### 3. Searchable Tags
AI now generates 3-5 tags for each file:
- Tags like: `auth`, `api`, `database`, `ui`, `utility`, `config`
- Stored in cache and file records
- Used in MCP search and server search endpoints

**Benefit:** Better search and discovery of relevant files

### 4. Next.js Route Detection
The mapper now creates implicit links for Next.js-style routing:
- Files in `app/` or `pages/` directories get `route` links to child routes
- Layout files (`layout.tsx`, `template.tsx`) get `layout` links to nested pages
- Weights: ROUTE=60, LAYOUT=90

**Benefit:** Better dependency graph for Next.js projects

### 5. New API Endpoints

#### Server Endpoints
- `GET /api/query?q=auth&limit=5` - Search and get full file data
- `GET /api/file/path/to/file.js` - Get full file by path
- `GET /api/search` - Updated to work with split storage

#### MCP Tools (reporose mcp)
- `reporose_analyze` - Scan repo to split storage
- `reporose_get_map` - Get lightweight map
- `reporose_search_files` - Search by path, description, tags
- `reporose_get_file` - Get full file details
- `reporose_get_dependencies` - Get file dependencies

### 6. MCP Documentation
Completely rewritten MCP setup section in README:
- Config locations for Claude Desktop, Cursor, etc.
- Working JSON config examples
- Environment variable requirements
- Troubleshooting tips

## Backwards Compatibility

All changes are backwards compatible:
- Falls back to old `map.json` format if `index.json` doesn't exist
- `reporose serve` works with both formats
- MCP tools work with both formats
- Existing cache is still valid (tags added on next run)

## Files Changed

### New Files
- `src/core/storage.js` - Split storage read/write
- `src/ai/file-filter.js` - AI pre-filtering logic

### Modified Files
- `src/core/mapper.js` - Added Next.js route detection
- `src/ai/summarizer.js` - Added tags, pre-filter, JSON response parsing
- `src/ai/prompts.js` - Updated prompts for tags
- `src/cli/commands.js` - Use split storage
- `src/server/server.js` - New endpoints, split storage support
- `src/mcp/server.js` - Use split storage
- `src/server/search.js` - Tag-based scoring
- `README.md` - Updated docs

## Migration Guide

No action needed. Just run:
```bash
reporose analyze
```

New output format will be used automatically. Old `map.json` is preserved until you delete it.

## Testing Checklist

- [ ] `reporose analyze` creates `index.json` + `files/` directory
- [ ] `reporose serve` loads both old and new formats
- [ ] MCP tools work with split storage
- [ ] Search includes tag matching
- [ ] Next.js projects show route links
- [ ] AI generates tags in descriptions
