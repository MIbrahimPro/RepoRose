'use strict';

/**
heuristic provider — the "fake AI" that works offline

instead of calling an actual AI, it looks at the code and makes up descriptions
based on patterns like:
- function names (getUser -> "Returns user")
- imports (react -> "its a react component")
- file structure

used as:
- default when no AI is configured
- fallback when real AI fails

also exported so other providers can fall back to it
 */

// how much file content to read for analysis (50KB)
const SNIPPET_LENGTH = 50000;

// maps language codes to pretty display names
const LANG_DISPLAY = {
  javascript: 'JavaScript',
  javascriptreact: 'JavaScript (JSX)',
  typescript: 'TypeScript',
  typescriptreact: 'TypeScript (TSX)',
  json: 'JSON',
  yaml: 'YAML',
  toml: 'TOML',
  css: 'CSS',
  scss: 'SCSS',
  sass: 'Sass',
  less: 'Less',
  markdown: 'Markdown',
  html: 'HTML',
  text: 'plain-text',
  sql: 'SQL',
  dotenv: 'dotenv',
  svg: 'SVG',
};

// maps function name prefixes to description verbs
// like "getUser" -> "Returns user"
const VERB_TEMPLATES = {
  get: 'Returns',
  fetch: 'Fetches',
  load: 'Loads',
  read: 'Reads',
  set: 'Sets',
  save: 'Saves',
  store: 'Stores',
  write: 'Writes',
  create: 'Creates',
  make: 'Creates',
  build: 'Builds',
  generate: 'Generates',
  update: 'Updates',
  modify: 'Modifies',
  patch: 'Patches',
  delete: 'Deletes',
  remove: 'Removes',
  destroy: 'Destroys',
  parse: 'Parses',
  format: 'Formats',
  serialize: 'Serializes',
  stringify: 'Serializes',
  validate: 'Validates',
  check: 'Checks',
  verify: 'Verifies',
  is: 'Returns whether',
  has: 'Returns whether',
  should: 'Returns whether',
  render: 'Renders',
  draw: 'Renders',
  handle: 'Handles',
  on: 'Handles',
  use: 'React hook for',
  init: 'Initializes',
  setup: 'Sets up',
  configure: 'Configures',
  compute: 'Computes',
  calculate: 'Calculates',
  count: 'Counts',
  filter: 'Filters',
  map: 'Maps',
  reduce: 'Reduces',
  sort: 'Sorts',
  find: 'Finds',
  search: 'Searches',
  match: 'Matches',
  send: 'Sends',
  emit: 'Emits',
  dispatch: 'Dispatches',
  start: 'Starts',
  stop: 'Stops',
  open: 'Opens',
  close: 'Closes',
  connect: 'Connects',
  disconnect: 'Disconnects',
  resolve: 'Resolves',
  reject: 'Rejects',
  authenticate: 'Authenticates',
  to: 'Converts to',
  from: 'Builds from',
  with: 'Wraps with',
  ensure: 'Ensures',
  apply: 'Applies',
  run: 'Runs',
  execute: 'Executes',
  process: 'Processes',
  transform: 'Transforms',
  normalize: 'Normalizes',
  sanitize: 'Sanitizes',
  hash: 'Hashes',
  encrypt: 'Encrypts',
  decrypt: 'Decrypts',
};

// gets the display name for a language code
function langDisplay(language) {
  return LANG_DISPLAY[language] || (language || 'unknown');
}

// splits camelCase or snake_case into separate words
// "getUserName" -> "get user name"
function splitWords(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// joins a list into a readable string with "and" and "+n more"
function joinList(items, max = 3) {
  if (!items.length) return '';
  const trimmed = items.slice(0, max);
  const more = items.length - trimmed.length;
  const quoted = trimmed.map((s) => `\`${s}\``);
  let body;
  if (quoted.length === 1) body = quoted[0];
  else if (quoted.length === 2) body = `${quoted[0]} and ${quoted[1]}`;
  else body = `${quoted.slice(0, -1).join(', ')}, and ${quoted[quoted.length - 1]}`;
  return more > 0 ? `${body} (+${more} more)` : body;
}

// guesses if a file is a react component
// checks for .jsx/.tsx extension or react imports
function looksLikeReactComponent(input) {
  if (input.language && input.language.endsWith('react')) return true;
  return (input.imports || []).some((i) => i.source === 'react' || i.source === 'preact');
}

// checks if file looks like a test file
// by name pattern (.test.js) or __tests__ folder
function looksLikeTest(input) {
  return /\.(test|spec)\.[tj]sx?$/.test(input.name) || input.path.split('/').includes('__tests__');
}

// detects express/koa middleware by function signature
// looks for req, res, next params
function looksLikeMiddleware(input) {
  // Express/Koa style: at least one function whose params include req+res(+next)
  return (input.functions || []).some((f) => /req[,\s].*res/.test(f.signature || ''));
}

// guesses if file is an API route handler
// checks path for api/ + pages/app/routes
function looksLikeApiRoute(input) {
  const segs = (input.path || '').split('/');
  return segs.includes('api') && (segs.includes('pages') || segs.includes('app') || segs.includes('routes'));
}

// generates a description from just the function name
// uses verb templates like get -> Returns
function describeFunctionByName(name) {
  if (!name) return null;
  const words = splitWords(name).split(' ').filter(Boolean);
  if (!words.length) return null;
  const head = words[0].toLowerCase();
  const tail = words.slice(1).join(' ').toLowerCase();
  const verb = VERB_TEMPLATES[head];
  if (verb) {
    return tail ? `${verb} ${tail}` : verb.toLowerCase();
  }
  return null;
}

// capitalizes first letter of a string
function capitalize(s) {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

// case-insensitive string includes check
function lowerIncludes(text, pattern) {
  return String(text || '').toLowerCase().includes(String(pattern).toLowerCase());
}

// guesses what UI component this file implements
// based on path and function names
function inferUiRole(input) {
  const haystack = `${input.path} ${input.name} ${(input.functions || []).map((f) => f.name).join(' ')}`;
  if (/navbar|nav/i.test(haystack)) return 'navigation bar';
  if (/footer/i.test(haystack)) return 'footer section';
  if (/header/i.test(haystack)) return 'header section';
  if (/dashboard/i.test(haystack)) return 'dashboard screen';
  if (/auth|login|signup|signin/i.test(haystack)) return 'authentication flow';
  if (/contact/i.test(haystack)) return 'contact page';
  if (/about/i.test(haystack)) return 'about page';
  if (/team/i.test(haystack)) return 'team page';
  if (/policy|terms|privacy/i.test(haystack)) return 'policy/legal page';
  if (/modal|dialog/i.test(haystack)) return 'modal dialog';
  if (/form/i.test(haystack)) return 'form-driven UI';
  if (/card/i.test(haystack)) return 'card-based UI section';
  return 'UI module';
}

// looks for code patterns to describe behavior
// like useState -> "manages state", fetch -> "talks to APIs"
function inferBehaviorSignals(input) {
  const snippet = String(input.snippet || '');
  const snippetLower = snippet.toLowerCase();
  const importSources = (input.imports || []).map((i) => i.source);
  const functionNames = (input.functions || []).map((f) => f.name).join(' ');
  const pathAndNames = `${input.path} ${input.name} ${functionNames}`.toLowerCase();
  const signals = [];

  if (/useState|useReducer/.test(snippet)) signals.push('manages local component state');
  if (/useEffect|useLayoutEffect/.test(snippet)) signals.push('runs side effects in response to lifecycle or state changes');
  if (/useContext/.test(snippet)) signals.push('consumes shared React context');
  if (/useNavigate|useLocation|useParams|useSearchParams|<Route|createBrowserRouter/.test(snippet)
    || importSources.some((s) => s === 'react-router-dom' || s === 'react-router')) {
    signals.push('integrates with client-side routing');
  }
  if (/fetch\(|axios|api\.|client\./i.test(snippet)) signals.push('talks to external APIs or data clients');
  if (/search/i.test(pathAndNames) || /search/i.test(snippetLower)) signals.push('implements search or query-driven filtering');
  if (/form|onsubmit|handlesubmit|input|textarea|select/i.test(snippetLower)) signals.push('handles form input and submission flows');
  if (/auth|login|logout|signup|signin|token|password|currentuser|isloggedin/i.test(pathAndNames + ' ' + snippetLower)) {
    signals.push('contains authentication-related logic or UI states');
  }
  if (/notif|toast|alert|bell/i.test(pathAndNames + ' ' + snippetLower)) signals.push('surfaces notifications or alerts');
  if (/avatar|profile|pfp|user image/i.test(pathAndNames + ' ' + snippetLower)) signals.push('renders user identity or profile visuals');
  if (/mobile|menuopen|ismen|drawer|hamburger/i.test(snippetLower)) signals.push('includes responsive navigation or mobile menu behavior');
  if (/chart|graph|analytics|metric|stats/i.test(pathAndNames + ' ' + snippetLower)) signals.push('presents analytics or metric-driven content');
  if (/canvas|drag|drop|builder|editor/i.test(pathAndNames + ' ' + snippetLower)) signals.push('supports builder-style or interactive canvas behavior');
  if (/audio|voice|sound|wave/i.test(pathAndNames + ' ' + snippetLower)) signals.push('renders audio or voice-related interaction states');

  return [...new Set(signals)];
}

// builds a full sentence describing a react component
function inferComponentSentence(input) {
  const role = inferUiRole(input);
  const localFiles = (input.imports || []).filter((i) => i.type === 'file').map((i) => i.source);
  const exportedNames = input.exported.map((e) => e.name).filter((name) => name !== 'default');
  const namedTarget = exportedNames[0]
    || (input.functions || []).find((f) => f.type === 'function')?.name
    || input.name.replace(/\.[^.]+$/, '');

  let sentence = `Implements the ${role} in \`${input.path}\``;
  if (namedTarget) sentence += ` through the \`${namedTarget}\` component`;
  sentence += '.';

  if (localFiles.length > 0) {
    sentence += ` It coordinates local modules such as ${joinList(localFiles, 4)}.`;
  }

  return sentence;
}
















/* ------------------------------------------------------------------ */
/* File summaries                                                      */
/* ------------------------------------------------------------------ */

// these functions generate descriptions for whole files

// generates a description for a code file
// handles different file types (test, component, middleware, etc)
function summarizeCodeFile(input) {
  const lang = langDisplay(input.language);
  const fns = input.functions.filter((f) => f.type === 'function').map((f) => f.name);
  const classes = input.functions.filter((f) => f.type === 'class').map((f) => f.name);
  const interfaces = input.functions.filter((f) => f.type === 'interface').map((f) => f.name);
  const types = input.functions.filter((f) => f.type === 'type').map((f) => f.name);
  const enums = input.functions.filter((f) => f.type === 'enum').map((f) => f.name);
  const consts = input.functions.filter((f) => f.type === 'constant').map((f) => f.name);

  const exportNames = input.exported.map((e) => e.name);
  const pkgImports = input.imports.filter((i) => i.type === 'package').map((i) => i.source);
  const fileImports = input.imports.filter((i) => i.type === 'file').map((i) => i.source);

  // Sentence 1 — primary role
  let sent1;
  if (looksLikeTest(input)) {
    const cases = exportNames.length || fns.length;
    sent1 = `${lang} test file (${input.name})${cases ? ` covering ${cases} scenario${cases > 1 ? 's' : ''}` : ''}.`;
  } else if (looksLikeApiRoute(input)) {
    sent1 = `${lang} API route handler at ${input.path}.`;
  } else if (looksLikeReactComponent(input) && (fns.length || classes.length)) {
    sent1 = inferComponentSentence(input);
  } else if (looksLikeMiddleware(input)) {
    sent1 = `${lang} middleware module exposing ${joinList(fns.length ? fns : exportNames, 3)}.`;
  } else if (
    classes.length
    && fns.length === 0
    && interfaces.length === 0
    && types.length === 0
    && enums.length === 0
  ) {
    sent1 = `${lang} module exposing ${joinList(classes, 3)} ${classes.length === 1 ? 'class' : 'classes'}.`;
  } else {
    const items = [];
    if (classes.length) items.push(`${classes.length} class${classes.length > 1 ? 'es' : ''}`);
    if (interfaces.length) items.push(`${interfaces.length} interface${interfaces.length > 1 ? 's' : ''}`);
    if (types.length) items.push(`${types.length} type${types.length > 1 ? 's' : ''}`);
    if (enums.length) items.push(`${enums.length} enum${enums.length > 1 ? 's' : ''}`);
    if (fns.length) items.push(`${fns.length} function${fns.length > 1 ? 's' : ''}`);
    if (consts.length) items.push(`${consts.length} constant${consts.length > 1 ? 's' : ''}`);
    if (items.length) sent1 = `${lang} module containing ${items.join(', ')}.`;
    else sent1 = `${lang} source file at \`${input.path}\`.`;
  }

  // Sentence 2 — dependencies
  let sent2 = '';
  if (pkgImports.length || fileImports.length) {
    const parts = [];
    if (pkgImports.length) parts.push(`packages ${joinList(pkgImports, 4)}`);
    if (fileImports.length) {
      parts.push(`local module${fileImports.length > 1 ? 's' : ''} ${joinList(fileImports, 3)}`);
    }
    sent2 = `Depends on ${parts.join(' and ')}.`;
  }

  // Sentence 3 — exports
  let sent3 = '';
  if (exportNames.length) {
    const hasDefault = exportNames.includes('default');
    const named = exportNames.filter((n) => n !== 'default');
    if (hasDefault && named.length) {
      sent3 = `Has a default export plus named exports ${joinList(named, 4)}.`;
    } else if (hasDefault) {
      sent3 = 'Provides a single default export.';
    } else {
      sent3 = `Exports ${joinList(named, 4)}.`;
    }
  } else if (input.functions.length) {
    sent3 = 'No symbols are exported from this module.';
  }

  const behaviorSignals = inferBehaviorSignals(input);
  const sent4 = behaviorSignals.length
    ? `From the available code, it ${behaviorSignals.join(', ')}.`
    : '';

  const snippetLower = String(input.snippet || '').toLowerCase();
  let sent5 = '';
  if (looksLikeReactComponent(input)) {
    if (/return\s*\(|<>|<div|<section|<main|<nav|<footer/i.test(input.snippet || '')) {
      sent5 = 'Its main responsibility is rendering and coordinating the visible UI for this area of the application.';
    }
  } else if (/process|transform|validate|parse|map|build/i.test(snippetLower)) {
    sent5 = 'Its main responsibility appears to be coordinating implementation logic rather than only declaring types or constants.';
  }

  return [sent1, sent2, sent3, sent4, sent5].filter(Boolean).join(' ');
}

// generates description for non-code files (config, docs, etc)
function summarizeNonCodeFile(input) {
  const lang = langDisplay(input.language);
  const sizeKb = (input.size_bytes / 1024).toFixed(1);
  switch (input.type) {
    case 'config':
      return `${lang} configuration file (${input.name}, ${sizeKb} KB) at \`${input.path}\`.`;
    case 'docs':
      return `${lang} documentation file (${input.name}, ${sizeKb} KB) at \`${input.path}\`.`;
    case 'media':
      return `${lang} media asset (${input.name}, ${sizeKb} KB) at \`${input.path}\`.`;
    case 'style':
      return `${lang} stylesheet (${input.name}, ${sizeKb} KB) at \`${input.path}\`.`;
    case 'database':
      return `${lang} SQL/database file (${input.name}, ${sizeKb} KB) at \`${input.path}\`.`;
    default:
      return `${lang} file (${input.name}, ${sizeKb} KB) at \`${input.path}\`.`;
  }
}

// main entry point for file descriptions
// routes to code or non-code handler
function heuristicFileDescription(input) {
  if (!input) return '';
  if (input.type === 'code') return summarizeCodeFile(input);
  return summarizeNonCodeFile(input);
}
















/* ------------------------------------------------------------------ */
/* Function summaries                                                  */
/* ------------------------------------------------------------------ */

// these functions generate descriptions for individual functions

// generates a description for a single function
function heuristicFunctionDescription(input) {
  if (!input) return '';
  const { name, type, signature, parameters, return_type } = input;
  if (type === 'class') {
    return `Defines the \`${name}\` class.`;
  }
  if (type === 'interface') {
    return `Declares the \`${name}\` interface contract.`;
  }
  if (type === 'type') {
    return `Type alias \`${name}\`.`;
  }
  if (type === 'enum') {
    return `Enum \`${name}\`.`;
  }
  if (type === 'constant') {
    return `Module-level constant \`${name}\`.`;
  }

  const verbPhrase = describeFunctionByName(name);
  const isAsync = (signature || '').includes('async');
  const paramCount = (parameters || []).length;
  const paramStr = paramCount > 0
    ? ` from ${paramCount} parameter${paramCount > 1 ? 's' : ''}`
    : '';
  const retStr = return_type ? `; returns \`${return_type}\`` : '';

  let core;
  if (verbPhrase) {
    core = capitalize(verbPhrase);
  } else if (/^[A-Z]/.test(name)) {
    core = `Component or constructor named \`${name}\``;
  } else {
    core = `Helper named \`${name}\``;
  }

  const asyncPrefix = isAsync ? 'Asynchronously ' : '';
  const body = isAsync ? `${core[0].toLowerCase() + core.slice(1)}` : core;
  return `${asyncPrefix}${body}${paramStr}${retStr}.`;
}
















/* ------------------------------------------------------------------ */
/* Provider object                                                     */
/* ------------------------------------------------------------------ */

// creates the actual provider object that the summarizer uses

// creates the heuristic provider with summarizeFile/summarizeFunction methods
function createHeuristicProvider() {
  return {
    name: 'heuristic',
    async summarizeFile(input) {
      return heuristicFileDescription(input);
    },
    async summarizeFullFile(input) {
      // For full file summarization, use the enhanced heuristic with full snippet
      // Build input with the full content from chunks
      const fullSnippet = input.chunks ? input.chunks.join('\n') : '';
      const enhancedInput = {
        ...input,
        snippet: fullSnippet.slice(0, SNIPPET_LENGTH),
      };
      return heuristicFileDescription(enhancedInput);
    },
    async summarizeFunction(input) {
      return heuristicFunctionDescription(input);
    },
    async close() {},
  };
}

module.exports = {
  createHeuristicProvider,
  heuristicFileDescription,
  heuristicFunctionDescription,
  splitWords,
  describeFunctionByName,
};
