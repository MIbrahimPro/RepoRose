'use strict';

/**
search module — full-text search over the repo map

how it works:
1. tokenize the query (lowercase, remove stop words)
2. score every file/function by:
   - exact name/path match = very high
   - substring match = high
   - token match in description = medium
   - token match in path/imports = low
   - importance score = tiebreaker
3. return top results (default 10)

used for the autocomplete search in the 3D viz
 */

// common words we ignore in search
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'does', 'for',
  'from', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'of', 'on', 'or', 'that', 'the', 'to', 'was', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'will', 'with', 'work', 'works', 'about', 'this',
]);

// splits query into searchable tokens
// removes punctuation, stopwords, short words
function tokenize(query) {
  if (!query) return [];
  return String(query)
    .toLowerCase()
    .replace(/[^a-z0-9_./@-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t) && t.length > 1);
}

// counts occurrences of needle in haystack (case insensitive)
function lcCount(haystack, needle) {
  if (!haystack || !needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  let idx = 0;
  while ((idx = h.indexOf(n, idx)) !== -1) {
    count += 1;
    idx += n.length;
  }
  return count;
}

// scores a file based on how well it matches the query
// exact matches get way more points than partial matches
function scoreFile(file, query, tokens) {
  let score = 0;
  const name = (file.name || '').toLowerCase();
  const pathStr = (file.path || '').toLowerCase();
  const desc = (file.description || '').toLowerCase();
  const q = String(query || '').toLowerCase().trim();

  if (q && name === q) score += 1000;
  if (q && pathStr === q) score += 800;
  if (q && name.includes(q)) score += 400;
  if (q && pathStr.includes(q)) score += 200;
  if (q && desc.includes(q)) score += 80;
  if (q && (file.tags || []).some(t => t.toLowerCase().includes(q))) score += 60;

  for (const tok of tokens) {
    if (name.includes(tok)) score += 60;
    if (pathStr.includes(tok)) score += 25;
    score += lcCount(desc, tok) * 10;
  }

  // Importance acts as a tiebreaker (0..10 → 0..10 bonus).
  score += (file.importance_score || 0);

  return score;
}

// scores a function (similar to file scoring but tweaked)
function scoreFunction(file, fn, query, tokens) {
  let score = 0;
  const name = (fn.name || '').toLowerCase();
  const sig = (fn.signature || '').toLowerCase();
  const desc = (fn.description || '').toLowerCase();
  const q = String(query || '').toLowerCase().trim();

  if (q && name === q) score += 900;
  if (q && name.includes(q)) score += 350;
  if (q && sig.includes(q)) score += 150;
  if (q && desc.includes(q)) score += 70;

  for (const tok of tokens) {
    if (name.includes(tok)) score += 50;
    if (sig.includes(tok)) score += 15;
    score += lcCount(desc, tok) * 8;
  }

  score += (file.importance_score || 0) * 0.5;
  return score;
}

// main search function
// searches files, functions, and packages
// returns sorted results by relevance
function search(map, query, options = {}) {
  const tokens = tokenize(query);
  const limit = Math.max(1, Math.min(50, options.limit || 10));
  const includeFunctions = options.includeFunctions !== false;
  const includePackages = options.includePackages !== false;
  const results = [];

  if (!query || (!query.trim() && tokens.length === 0)) {
    return { query, tokens, results: [] };
  }

  for (const file of map.files || []) {
    const fileScore = scoreFile(file, query, tokens);
    if (fileScore > 0) {
      results.push({
        kind: 'file',
        id: file.id,
        file_id: file.id,
        name: file.name,
        path: file.path,
        description: file.description || '',
        importance: file.importance_score || 0,
        score: fileScore,
      });
    }

    if (!includeFunctions) continue;
    for (const fn of file.functions || []) {
      const fnScore = scoreFunction(file, fn, query, tokens);
      if (fnScore > 0) {
        results.push({
          kind: 'function',
          id: fn.id,
          file_id: file.id,
          name: fn.name,
          path: `${file.path}::${fn.name}`,
          signature: fn.signature || '',
          description: fn.description || '',
          importance: file.importance_score || 0,
          score: fnScore,
        });
      }
    }
  }

  if (includePackages) {
    const q = String(query || '').toLowerCase().trim();
    for (const pkg of map.packages || []) {
      const name = (pkg.name || '').toLowerCase();
      let score = 0;
      if (q && name === q) score += 700;
      if (q && name.includes(q)) score += 250;
      for (const tok of tokens) {
        if (name.includes(tok)) score += 40;
      }
      if (score > 0) {
        results.push({
          kind: 'package',
          id: pkg.id,
          name: pkg.name,
          path: pkg.name,
          description: `${pkg.type || 'dependency'} package${pkg.version ? ' v' + pkg.version : ''}, used ${pkg.usage_count || 0} times`,
          importance: pkg.usage_count || 0,
          score,
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return { query, tokens, results: results.slice(0, limit) };
}

module.exports = { search, tokenize };
