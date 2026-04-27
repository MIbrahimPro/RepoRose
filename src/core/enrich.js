'use strict';

/**
Map.json enrichments — adds the juicy metadata that makes the map actually useful

what we add:
1. env_vars - finds all the env variables your code uses (so you know what config you need)
2. tags - classifies what each file does (api stuff, database, auth, etc)
3. route - figures out Next.js routes from file paths
4. transitive_imports/_imported_by - who imports who imports who (2 levels deep)

basically takes the raw scan and makes it smart
 */

const path = require('path');

/* ------------------------------------------------------------------ */
/* 1. Environment Variable Detection                                 */
/* ------------------------------------------------------------------ */

// regex patterns to find env variable usage (I need to fckn learn regex,, its everywhere)
// supports: Node.js, Vite, Deno, Bun, and destructuring syntax
const ENV_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,                           // process.env.VAR_NAME
  /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,                    // Vite style
  /Deno\.env\.get\(['"`]([A-Z][A-Z0-9_]+)['"`]\)/g,            // Deno style
  /Bun\.env\.([A-Z][A-Z0-9_]*)/g,                              // Bun style
  /const\s*{\s*([A-Z][A-Z0-9_,\s]+)\s*}\s*=\s*(?:process|import\.meta)\.env/g,  // destructuring
];

/**
scans file content and pulls out all env variable names
like if you have process.env.API_KEY, it finds "API_KEY"

@param {string} content - the file content to scan
@returns {string[]} - sorted array of unique env var names
 */
function extractEnvVars(content) {
  if (!content) return [];
  const vars = new Set();

  for (const pattern of ENV_PATTERNS) {
    const regex = new RegExp(pattern);
    let match;
    while ((match = regex.exec(content)) !== null) {
      const capture = match[1];
      // handle destructuring: const { A, B, C } = process.env
      if (capture.includes(',')) {
        for (const v of capture.split(',')) {
          const trimmed = v.trim();
          // only valid env var names (ALL_CAPS)
          if (/^[A-Z][A-Z0-9_]*$/.test(trimmed)) vars.add(trimmed);
        }
      } else if (/^[A-Z][A-Z0-9_]*$/.test(capture)) {
        vars.add(capture);
      }
    }
  }

  return Array.from(vars).sort();
}

/* ------------------------------------------------------------------ */
/* 2. Behavior Tags                                                    */
/* ------------------------------------------------------------------ */

// patterns to detect what "type" of file this is
// we scan the code for these patterns and tag the file accordingly
// and yes it had to be regex again 
const TAG_PATTERNS = {
  // makes HTTP requests or API calls
  'api-client': [
    /\bfetch\s*\(/,
    /\baxios\b/,
    /\bgot\b/,
    /\bnode-fetch\b/,
    /\bundici\b/,
    /\buseQuery\s*\(/,
    /\buseMutation\s*\(/,
    /\buseSWR\s*\(/,
    /\bApolloClient\b/,
    /\bgraphql\s*\(/,
  ],
  // stores stuff in browser (cookies, localStorage, etc)
  'browser-storage': [
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bdocument\.cookie\b/,
    /\bcookies\.set\b/,
    /\bIndexedDB\b/,
  ],
  // React hooks that do side effects
  'side-effect-hook': [
    /\buseEffect\s*\(/,
    /\buseLayoutEffect\s*\(/,
    /\buseInsertionEffect\s*\(/,
  ],
  // talks to databases
  'db-client': [
    /\bmongoose\b/,
    /\bprisma\b/,
    /\b@prisma\/client\b/,
    /\bpg\b/,
    /\bmysql2\b/,
    /\bsequelize\b/,
    /\bdrizzle-orm\b/,
    /\bkysely\b/,
    /\bsupabase\b/,
    /\bfirebase\b/,
  ],
  // handles authentication
  'auth': [
    /\bnext-auth\b/,
    /\b@auth\//,
    /\bpassport\b/,
    /\bjsonwebtoken\b/,
    /\bjwt\b/,
    /\bbcrypt\b/,
    /\bargon2\b/,
    /\bcrypto\b/,
    /\bsession\b/,
  ],
  // handles routing/navigation
  'routing': [
    /\breact-router\b/,
    /\bvue-router\b/,
    /\b@tanstack\/react-router\b/,
    /\buseRouter\b/,
    /\buseSearchParams\b/,
    /\buseParams\b/,
    /\bLink\s+from\s+['"]next\/link['"]/,
    /\busePathname\s*\(/,
  ],
};

/**
figures out what "type" of file this is by scanning its code and imports
like "oh this file uses axios and fetch, must be an api-client"
or "this uses mongoose, its a db-client"

@param {string} content - file content to scan
@param {Array} imports - the files imports (some tags come from imports)
@returns {string[]} - sorted array of tags
 */
function detectTags(content, imports = []) {
  if (!content) return [];
  const tags = new Set();
  const importSources = new Set(imports.map(i => i.source));

  // Check content patterns
  for (const [tag, patterns] of Object.entries(TAG_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        tags.add(tag);
        break;
      }
    }
  }

  // Check import-based tags
  const importTagMap = {
    'api-client': ['axios', 'node-fetch', 'undici', '@tanstack/react-query', '@apollo/client', 'graphql-request'],
    'db-client': ['mongoose', '@prisma/client', 'pg', 'mysql2', 'sequelize', 'drizzle-orm', 'kysely', '@supabase/supabase-js', 'firebase'],
    'auth': ['next-auth', '@auth/core', 'passport', 'jsonwebtoken', 'bcrypt', 'argon2'],
    'routing': ['react-router-dom', 'vue-router', '@tanstack/react-router'],
  };

  for (const [tag, packages] of Object.entries(importTagMap)) {
    for (const pkg of packages) {
      if (importSources.has(pkg)) {
        tags.add(tag);
        break;
      }
    }
  }

  return Array.from(tags).sort();
}

/* ------------------------------------------------------------------ */
/* 3. Next.js Route Mapping                                            */
/* ------------------------------------------------------------------ */

/**
figures out the URL route for Next.js files
app/users/page.tsx -> /users
pages/blog/[slug].tsx -> /blog/:slug

@param {string} filePath - the file path
@returns {string|null} - the route or null if not a route file
 */
function extractNextJsRoute(filePath) {
  if (!filePath) return null;

  // app router: src/app/(group)/login/page.tsx -> /login
  // handles route groups (parentheses), skips special files
  const appMatch = filePath.match(/\/(?:src\/)?app\/(?:(?:\([^)]+\)\/)*)([^/]+(?:\/[^/]+)*)\/(?:page|route)\.\w+$/);
  if (appMatch) {
    const route = '/' + appMatch[1].replace(/\/page$/, '').replace(/\/route$/, '');
    // Skip special files
    if (['layout', 'loading', 'error', 'not-found', 'template', 'default'].includes(appMatch[1])) {
      return null;
    }
    return route;
  }

  // pages router: pages/about.tsx -> /about, pages/blog/[slug].tsx -> /blog/:slug
  const pagesMatch = filePath.match(/\/(?:src\/)?pages\/(.+)\.\w+$/);
  if (pagesMatch) {
    let route = '/' + pagesMatch[1]
      .replace(/\/index$/, '')
      .replace(/\[\.\.\.(.+)\]/, '*')  // catch-all [...slug]
      .replace(/\[(.+)\]/, ':$1');        // dynamic [slug]
    // API routes
    if (route.startsWith('/api/')) {
      return route;
    }
    // Skip _app, _document, _error
    if (['_app', '_document', '_error', '_middleware', '_404'].includes(pagesMatch[1])) {
      return null;
    }
    return route || '/';
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 4. Transitive Dependencies                                          */
/* ------------------------------------------------------------------ */

/**
builds "friends of friends" import map
if A imports B and B imports C, then A transitively imports C
only goes 2 levels deep cuz deeper gets messy

@param {object} files - map.files array
@returns {Map<string, string[]>} - map of file path -> transitive imports
 */
function buildTransitiveImports(files) {
  const result = new Map();
  const directImports = new Map();

  // Build direct import map
  for (const file of files) {
    directImports.set(file.path, new Set((file.imports || []).map(i => i.source)));
  }

  // Build transitive (depth 2)
  for (const file of files) {
    const transitive = new Set();
    const direct = directImports.get(file.path) || new Set();

    for (const imp of direct) {
      // Find the file that provides this import
      const importedFile = files.find(f => f.path === imp || f.path.replace(/\.\w+$/, '') === imp.replace(/\.\w+$/, ''));
      if (importedFile) {
        // Add its direct imports
        const secondLevel = directImports.get(importedFile.path) || new Set();
        for (const t of secondLevel) {
          if (t !== file.path && !direct.has(t)) {
            transitive.add(t);
          }
        }
      }
    }

    result.set(file.path, Array.from(transitive).sort());
  }

  return result;
}

/**
same as transitive imports but reverse direction
who imports files that import this file

@param {object} files - map.files array
@returns {Map<string, string[]>} - map of file path -> transitive imported_by
 */
function buildTransitiveImportedBy(files) {
  const result = new Map();
  const directImportedBy = new Map();

  // Build direct imported_by map
  for (const file of files) {
    directImportedBy.set(file.path, new Set());
  }
  for (const file of files) {
    for (const imp of file.imports || []) {
      if (imp.type === 'file') {
        const target = directImportedBy.get(imp.source);
        if (target) {
          target.add(file.path);
        }
      }
    }
  }

  // Build transitive (depth 2)
  for (const file of files) {
    const transitive = new Set();
    const direct = directImportedBy.get(file.path) || new Set();

    for (const importer of direct) {
      const secondLevel = directImportedBy.get(importer) || new Set();
      for (const t of secondLevel) {
        if (t !== file.path && !direct.has(t)) {
          transitive.add(t);
        }
      }
    }

    result.set(file.path, Array.from(transitive).sort());
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Main Enrichment                                                     */
/* ------------------------------------------------------------------ */

/**
the main entry point - enriches all files with the good stuff
this mutates the files in place (adds env_vars, tags, routes, transitive deps)

@param {Array} files - map.files array
@param {object} options
@param {boolean} [options.includeContent] - scan content or skip
@returns {Array} - enriched files (same array, mutated)
 */
function enrichFiles(files, options = {}) {
  const { includeContent = true } = options;

  // pre-compute the transitive stuff (its expensive so do it once)
  const transitiveImports = buildTransitiveImports(files);
  const transitiveImportedBy = buildTransitiveImportedBy(files);

  for (const file of files) {
    if (!file || file.type !== 'code') continue;

    // 1. Environment variables
    if (includeContent && file.content) {
      file.env_vars = extractEnvVars(file.content);
    }

    // 2. Behavior tags
    if (includeContent) {
      file.tags = detectTags(file.content, file.imports || []);
    }

    // 3. Next.js route
    const route = extractNextJsRoute(file.path);
    if (route) {
      file.route = route;
    }

    // 4. Transitive dependencies
    file.transitive_imports = transitiveImports.get(file.path) || [];
    file.transitive_imported_by = transitiveImportedBy.get(file.path) || [];

    // remove content cuz it makes the json huge and we dont need it anymore
    delete file.content;
  }

  return files;
}

module.exports = {
  enrichFiles,
  extractEnvVars,
  detectTags,
  extractNextJsRoute,
  buildTransitiveImports,
  buildTransitiveImportedBy,
};
