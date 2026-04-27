'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const parser = require('@babel/parser');

const { loadIgnore } = require('../utils/ignore');
const { enrichFiles } = require('./enrich');

const FORMAT_VERSION = '2.0';








/* --------------------------------------------------------------------------------------------------------------------------------- */
/* File-type categorizing,,,, type shit,,,, basically telling which extensions belong to which category                                   */
/* --------------------------------------------------------------------------------------------------------------------------------- */

const EXT_CATEGORY = {
  // code - logic files only (aggressive mode default)
  '.js': 'code',
  '.jsx': 'code',
  '.ts': 'code',
  '.tsx': 'code',
  '.mjs': 'code',
  '.cjs': 'code',
  '.vue': 'code',
  '.svelte': 'code',
  // config - excluded by default
  '.json': 'config',
  '.yaml': 'config',
  '.yml': 'config',
  '.toml': 'config',
  '.ini': 'config',
  '.conf': 'config',
  '.config': 'config',
  '.lock': 'config',
  // style - excluded by default
  '.css': 'style',
  '.scss': 'style',
  '.sass': 'style',
  '.less': 'style',
  '.styl': 'style',
  '.stylus': 'style',
  '.pcss': 'style',
  // docs - excluded by default
  '.md': 'docs',
  '.markdown': 'docs',
  '.html': 'docs',
  '.htm': 'docs',
  '.txt': 'docs',
  '.rst': 'docs',
  '.adoc': 'docs',
  // media - excluded by default (aggressive list)
  '.png': 'media',
  '.jpg': 'media',
  '.jpeg': 'media',
  '.gif': 'media',
  '.svg': 'media',
  '.webp': 'media',
  '.ico': 'media',
  '.avif': 'media',
  '.bmp': 'media',
  '.tiff': 'media',
  '.tif': 'media',
  '.raw': 'media',
  '.heic': 'media',
  '.heif': 'media',
  '.mp4': 'media',
  '.mov': 'media',
  '.webm': 'media',
  '.avi': 'media',
  '.mkv': 'media',
  '.flv': 'media',
  '.wmv': 'media',
  '.mp3': 'media',
  '.wav': 'media',
  '.aac': 'media',
  '.ogg': 'media',
  '.flac': 'media',
  '.m4a': 'media',
  '.wma': 'media',
  '.aiff': 'media',
  // archives - excluded by default
  '.zip': 'archive',
  '.tar': 'archive',
  '.gz': 'archive',
  '.bz2': 'archive',
  '.xz': 'archive',
  '.7z': 'archive',
  '.rar': 'archive',
  '.tgz': 'archive',
  // fonts - excluded by default
  '.ttf': 'font',
  '.otf': 'font',
  '.woff': 'font',
  '.woff2': 'font',
  '.eot': 'font',
  // other binary/data - excluded by default
  '.pdf': 'binary',
  '.doc': 'binary',
  '.docx': 'binary',
  '.xls': 'binary',
  '.xlsx': 'binary',
  '.ppt': 'binary',
  '.pptx': 'binary',
  '.exe': 'binary',
  '.dll': 'binary',
  '.so': 'binary',
  '.dylib': 'binary',
  '.wasm': 'binary',
  // database
  '.sql': 'database',
  '.db': 'database',
  '.sqlite': 'database',
};

const EXT_LANGUAGE = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.txt': 'text',
  '.rst': 'restructuredtext',
  '.sql': 'sql',
  '.svg': 'svg',
};

// These are special files,,, but not more special than you are,, my sweatheart   
const SPECIAL_NAMES = {
  '.env': 'config',
  '.env.example': 'config',
  '.env.local': 'config',
  '.env.development': 'config',
  '.env.production': 'config',
  '.gitignore': 'config',
  '.npmignore': 'config',
  '.eslintrc': 'config',
  '.prettierrc': 'config',
  Dockerfile: 'config',
  Makefile: 'config',
  README: 'docs',
};



function getCategory(filename) {
  
  if (SPECIAL_NAMES[filename]) return SPECIAL_NAMES[filename];
  //some people are special AND rare,,, they are a secret
  if (filename.startsWith('.env.')) return 'config';

  const ext = path.extname(filename).toLowerCase();
  return EXT_CATEGORY[ext] || 'other';
}

function getLanguage(filename) {
  // as I said,,, special people get treated special
  if (filename === '.env' || filename.startsWith('.env.')) return 'dotenv';

  // normal people get their desired language
  const ext = path.extname(filename).toLowerCase();
  return EXT_LANGUAGE[ext] || 'unknown';
}

















/* ------------------------------------------------------------------ */
/* AST parsing   (this is kinda the main important part)              */
/* ------------------------------------------------------------------ */

// psst I dont know what this part does,,, I used a prompt for this part,,,, I just know its some important shit,
// The idea on top is to tell Babel which JavaScript/TypeScript features to understand when parsing code. Each plugin enables a specific modern syntax,,, which I dont know which one does what
// If you know,,, just add details in front of the plugins
const BABEL_BASE_PLUGINS = [
  'classProperties',            // placeholder details
  'classPrivateProperties',
  'classPrivateMethods',
  'decorators-legacy',
  'dynamicImport',
  'optionalChaining',
  'nullishCoalescingOperator',
  'objectRestSpread',
  'asyncGenerators',
  'topLevelAwait',
  'importMeta',
  'exportDefaultFrom',
  'exportNamespaceFrom',
  'numericSeparator',
  'logicalAssignment',
];

function buildPlugins(filename) {
  const ext = path.extname(filename).toLowerCase(); //gets file extension
  const isTS = ext === '.ts' || ext === '.tsx';     //checks if file is typescript
  const isJSX = ext === '.jsx' || ext === '.tsx';   //checks if file is jsx (HTML, in Javascript for react))
  const plugins = [...BABEL_BASE_PLUGINS];          //creates a copy of the base plugins
  if (isTS) plugins.push('typescript');             //modifies (dont mind spelling) the copy by adding typescript plugin if file is typescript
  if (isJSX) plugins.push('jsx');                   //modifies the copy by adding jsx plugin if file is jsx
  return plugins;
}
function parseSource(source, filename) {
  return parser.parse(source, {
    sourceType: 'module',               //treat as import export and not as commonjs require
    allowImportExportEverywhere: true,  //allow import and export anywhere in the code
    allowReturnOutsideFunction: true,   //allow return outside function
    allowAwaitOutsideFunction: true,    //allow await outside function
    allowUndeclaredExports: true,       //allow undeclared exports
    errorRecovery: true,                //recover from errors
    plugins: buildPlugins(filename),    // calls the function above
  });
}












/* ------------------------------------------------------------------ */
/* AST helpers                                                        */
/* ------------------------------------------------------------------ */
// THese are good people,,, they help us navigate the AST

// watch your fingers,,, this one slices stuff (cherry picks only the code and returns it)
function sliceNode(source, node) {
  if (node == null || node.start == null || node.end == null) return '';   // if there is nothing comming in,, there is nothing going out,,, type shit
  return source.slice(node.start, node.end);  //If f the AST node represents `function foo() {}`, and `node.start = 0` and `node.end = 16`, this returns `"function foo() {}"`
}

//convertmulti line and extra spaces into single space
function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim();    // I dont know regex,,this is supposed to remove all the whitespace and replace it with a single space (even \n to space,, making multi line into single line)
}

//convert function parameters into strings
function paramsToStrings(source, fnNode) {
  if (!fnNode || !fnNode.params) return [];  // same if no then no
  return fnNode.params.map((p) => oneLine(sliceNode(source, p)));  // function foo(a: string, b = 5) → ["a: string", "b = 5"]
}

//get return type of a function
function returnTypeString(source, fnNode) {
  if (!fnNode) return null;
  const rt = fnNode.returnType;
  if (rt && rt.typeAnnotation) {
    return oneLine(sliceNode(source, rt.typeAnnotation));
  }
  return null;
}

// here we create the signature that is put into the map (signature basically tells us what goes in and what comes out of the function, without telling the HOW it was converted)
function functionSignature(source, fnNode, opts) {

  // opts = { name, kind, exported },,, name is function name
  // kind is the type of function (function-declaration, arrow-const, function-const, etc.)
  // exported is a boolean indicating if the function is exported
  const { name, kind, exported } = opts;

  // we get the parameters and return type of the function
  // this tells us what goes in and what comes out of the function
  const params = paramsToStrings(source, fnNode);
  const ret = returnTypeString(source, fnNode);

  // test if the function is async, generator and export and adds prefix accordingly 
  const asyncStr = fnNode.async ? 'async ' : '';
  const genStr = fnNode.generator ? '*' : '';
  const exportStr = exported ? 'export ' : '';

  // now we create the signature string based on the kind of function
  if (kind === 'function-declaration') {
    return `${exportStr}${asyncStr}function${genStr} ${name}(${params.join(', ')})${ret ? ': ' + ret : ''}`;
  }
  if (kind === 'arrow-const') {
    return `${exportStr}const ${name} = ${asyncStr}(${params.join(', ')})${ret ? ': ' + ret : ''} =>`;
  }
  if (kind === 'function-const') {
    return `${exportStr}const ${name} = ${asyncStr}function${genStr}(${params.join(', ')})${ret ? ': ' + ret : ''}`;
  }
  // fallback
  return `${exportStr}${name}(${params.join(', ')})`;
}

// This part also done by AI and i dont know how but
// here we detect if the node is a require call
// Example: require('./utils') → returns './utils'
function detectRequireCall(node) {
  if (
    node &&
    node.type === 'CallExpression' &&
    node.callee &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require' &&
    node.arguments.length > 0 &&
    (node.arguments[0].type === 'StringLiteral' || node.arguments[0].type === 'Literal')
  ) {
    return node.arguments[0].value;
  }
  return null;
}

// This function determines whether an import is a file path or a package name.
// If the source starts with ., .., or /, it's a file path (relative or absolute)
// Otherwise, it's a package name (installed via npm)

function importSourceType(source) {
  // Anything starting with ./ or ../ or / is treated as a file.
  if (source.startsWith('.') || source.startsWith('/')) return 'file';
  return 'package';
}

















/* ------------------------------------------------------------------ */
/* Top-level extraction                                                */
/* ------------------------------------------------------------------ */

// This is the main extractor,,, it walks through the AST and pulls out everything important
// functions, classes, imports, exports, constants, types,,, you name it
function extractFromAst(ast, source, fileId) {
  // arrays to store all the stuff we find
  const items = [];        // functions, classes, constants, etc.
  const exportsArr = [];   // everything exported
  const imports = [];      // everything imported
  let counter = 1;         // for generating unique IDs

  // creates IDs like func_001, func_002,,, so each item has its own identity
  const nextId = () => `${fileId.replace(/^file_/, 'func_')}_${String(counter++).padStart(2, '0')}`;

  // helper to add an item to our collection
  function pushItem(item) {
    items.push(item);
    return item;
  }

  // helper to add an import,,, figures out if its a file or package
  function addImport(sourceVal, line) {
    imports.push({
      source: sourceVal,
      type: importSourceType(sourceVal),
      line_imported: line,
    });
  }

  // helper to add an export,,, keeps track of whats being shared with the world
  function addExport(name, type, id) {
    exportsArr.push({ name, type, id: id || null });
  }

  // handles regular function declarations like: function foo() {}
  function handleFunctionDeclaration(node, exported) {
    const name = node.id ? node.id.name : 'default';
    // create the item with all the juicy details
    const item = pushItem({
      id: nextId(),
      name,
      type: 'function',
      signature: functionSignature(source, node, {
        name,
        kind: 'function-declaration',
        exported,
      }),
      line_start: node.loc.start.line,
      line_end: node.loc.end.line,
      description: '',
      exports: !!exported,
      parameters: paramsToStrings(source, node),
      return_type: returnTypeString(source, node),
    });
    if (exported) addExport(name, 'function', item.id);  // mark it as exported if needed
    return item;
  }

  // handles class declarations like: class Foo {}
  function handleClassDeclaration(node, exported) {
    const name = node.id ? node.id.name : 'default';
    // slice only the class header (name, extends, implements), not the whole body
    const headerEnd = node.body && node.body.start != null ? node.body.start : node.end;
    const item = pushItem({
      id: nextId(),
      name,
      type: 'class',
      signature: oneLine(source.slice(node.start, headerEnd)),
      line_start: node.loc.start.line,
      line_end: node.loc.end.line,
      description: '',
      exports: !!exported,
      parameters: [],
      return_type: null,
    });
    if (exported) addExport(name, 'class', item.id);
    return item;
  }

  // handles variable declarations,,, this ones tricky cuz it can be anything
  // const x = 5, const foo = () => {}, const obj = require('y')
  function handleVariableDeclaration(node, exported) {
    for (const decl of node.declarations) {
      const init = decl.init;

      // check if its a require call like: const x = require('y')
      // or even destructured: const { x } = require('y')
      if (init) {
        const reqSrc = detectRequireCall(init);
        if (reqSrc) addImport(reqSrc, node.loc.start.line);
      }

      // if its a destructuring pattern like const { a, b } = obj,, skip it
      if (!decl.id || decl.id.type !== 'Identifier') {
        continue;
      }
      const name = decl.id.name;

      // check if its a function assigned to a variable
      // like const foo = () => {} or const bar = function() {}
      if (
        init &&
        (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')
      ) {
        const kind = init.type === 'ArrowFunctionExpression' ? 'arrow-const' : 'function-const';
        const item = pushItem({
          id: nextId(),
          name,
          type: 'function',
          signature: functionSignature(source, init, { name, kind, exported }),
          line_start: decl.loc.start.line,
          line_end: decl.loc.end.line,
          description: '',
          exports: !!exported,
          parameters: paramsToStrings(source, init),
          return_type: returnTypeString(source, init),
        });
        if (exported) addExport(name, 'function', item.id);
      } else {
        // just a regular constant like const x = 5
        // keep the signature short (max 240 chars),, no one wants to read a novel
        const item = pushItem({
          id: nextId(),
          name,
          type: 'constant',
          signature: oneLine(source.slice(decl.start, decl.end)).slice(0, 240),
          line_start: decl.loc.start.line,
          line_end: decl.loc.end.line,
          description: '',
          exports: !!exported,
          parameters: [],
          return_type: null,
        });
        if (exported) addExport(name, 'constant', item.id);
      }
    }
  }

  // handles TypeScript interfaces like: interface Foo { bar: string }
  function handleTSInterface(node, exported) {
    const name = node.id.name;
    const item = pushItem({
      id: nextId(),
      name,
      type: 'interface',
      signature: `interface ${name}`,
      line_start: node.loc.start.line,
      line_end: node.loc.end.line,
      description: '',
      exports: !!exported,
      parameters: [],
      return_type: null,
    });
    if (exported) addExport(name, 'interface', item.id);
  }

  // handles TypeScript type aliases like: type MyType = string | number
  function handleTSTypeAlias(node, exported) {
    const name = node.id.name;
    const item = pushItem({
      id: nextId(),
      name,
      type: 'type',
      signature: oneLine(source.slice(node.start, node.end)).slice(0, 240),
      line_start: node.loc.start.line,
      line_end: node.loc.end.line,
      description: '',
      exports: !!exported,
      parameters: [],
      return_type: null,
    });
    if (exported) addExport(name, 'type', item.id);
  }

  // handles TypeScript enums like: enum Color { Red, Green, Blue }
  function handleTSEnum(node, exported) {
    const name = node.id.name;
    const item = pushItem({
      id: nextId(),
      name,
      type: 'enum',
      signature: `enum ${name}`,
      line_start: node.loc.start.line,
      line_end: node.loc.end.line,
      description: '',
      exports: !!exported,
      parameters: [],
      return_type: null,
    });
    if (exported) addExport(name, 'enum', item.id);
  }

  // dispatcher,,, routes to the right handler based on what we found
  function handleDeclaration(node, exported) {
    switch (node.type) {
      case 'FunctionDeclaration':
        return handleFunctionDeclaration(node, exported);
      case 'ClassDeclaration':
        return handleClassDeclaration(node, exported);
      case 'VariableDeclaration':
        return handleVariableDeclaration(node, exported);
      case 'TSInterfaceDeclaration':
        return handleTSInterface(node, exported);
      case 'TSTypeAliasDeclaration':
        return handleTSTypeAlias(node, exported);
      case 'TSEnumDeclaration':
        return handleTSEnum(node, exported);
      default:
        return null;
    }
  }

  // now we walk through every top-level statement in the file
  for (const node of ast.program.body) {
    // ES6 import like: import foo from './bar'
    if (node.type === 'ImportDeclaration') {
      addImport(node.source.value, node.loc.start.line);
      continue;
    }

    // named export like: export const x = 1 or export { foo }
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        handleDeclaration(node.declaration, true);  // export the declaration itself
      }
      if (node.specifiers && node.specifiers.length) {
        for (const spec of node.specifiers) {
          if (spec.type === 'ExportSpecifier') {
            const exportedName =
              spec.exported.type === 'Identifier' ? spec.exported.name : spec.exported.value;
            addExport(exportedName, 'reference', null);  // export by reference
          }
        }
      }
      // re-export like: export { foo } from './bar'
      if (node.source) {
        addImport(node.source.value, node.loc.start.line);
      }
      continue;
    }

    // default export like: export default function() {} or export default class {}
    if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration;
      if (decl.type === 'FunctionDeclaration') {
        const item = handleFunctionDeclaration(decl, true);
        if (item && item.name === 'default') addExport('default', 'function', item.id);
        else if (item) addExport('default', 'function', item.id);
      } else if (decl.type === 'ClassDeclaration') {
        const item = handleClassDeclaration(decl, true);
        if (item) addExport('default', 'class', item.id);
      } else if (decl.type === 'Identifier') {
        // export default someVariable
        addExport('default', 'reference', null);
      } else {
        // anonymous export like: export default () => {} or export default {},
        const isFn = decl.type === 'ArrowFunctionExpression' || decl.type === 'FunctionExpression';
        const item = pushItem({
          id: nextId(),
          name: 'default',
          type: isFn ? 'function' : decl.type === 'ClassExpression' ? 'class' : 'constant',
          signature: oneLine(source.slice(decl.start, Math.min(decl.end, decl.start + 240))),
          line_start: node.loc.start.line,
          line_end: node.loc.end.line,
          description: '',
          exports: true,
          parameters: isFn ? paramsToStrings(source, decl) : [],
          return_type: isFn ? returnTypeString(source, decl) : null,
        });
        addExport('default', item.type, item.id);
      }
      continue;
    }

    // re-export everything like: export * from './module'

    if (node.type === 'ExportAllDeclaration') {
      if (node.source) addImport(node.source.value, node.loc.start.line);
      continue;
    }

    // CommonJS style: const x = require('y')
    if (node.type === 'VariableDeclaration') {
      handleVariableDeclaration(node, false);
      continue;
    }

    // bare require like: require('./foo') at top level
    if (node.type === 'ExpressionStatement') {
      const expr = node.expression;
      const reqSrc = detectRequireCall(expr);
      if (reqSrc) {
        addImport(reqSrc, node.loc.start.line);
        continue;
      }
      // CommonJS module.exports = ...
      if (
        expr.type === 'AssignmentExpression' &&
        expr.left.type === 'MemberExpression' &&
        expr.left.object.type === 'Identifier' &&
        expr.left.object.name === 'module' &&
        expr.left.property.type === 'Identifier' &&
        expr.left.property.name === 'exports'
      ) {
        addExport('default', 'reference', null);
        continue;
      }
      continue;
    }

    handleDeclaration(node, false);
  }

  return { items, exports: exportsArr, imports };
}
















/* ------------------------------------------------------------------                   */
/* File walking (Like walking your dog,,,oh shit you forgot to walk your dog didn't you)*/
/* ------------------------------------------------------------------                   */

// this function walks through the repo like a curious explorer
// finds all files and decides what to scan and what to skip
function walkRepository(repoPath, ig, onEntry, options = {}) {
  // unpack the options,,, aggressive mode means we only care about code files
  const { includeHidden = false, includeDocs = false, includeMedia = false, aggressive = true } = options;

  // these are never useful to scan (binary stuff, archives, fonts)
  const HARD_SKIP = new Set(['archive', 'font', 'binary']);

  // soft exclusions,,, can be overridden by flags
  // in aggressive mode we skip everything thats not code
  const SKIP_CATEGORIES = new Set();
  if (!aggressive) {
    // chill mode: respect what the user wants
    if (!includeDocs) {
      SKIP_CATEGORIES.add('docs');
      SKIP_CATEGORIES.add('database');
    }
    if (!includeMedia) {
      SKIP_CATEGORIES.add('media');
    }
  }

  // recursive function to walk a directory
  function walkDir(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });  // get all entries with type info
    } catch (err) {
      onEntry({ kind: 'error', path: dir, error: err });  // cant read this dir, report it
      return;
    }

    // go through every entry in this directory
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);  // absolute path
      const rel = path.relative(repoPath, abs).split(path.sep).join('/');  // relative path with forward slashes
      if (!rel) continue;

      // always skip .git folder (its huge and not useful for us)
      if (entry.name === '.git') continue;

      // skip hidden folders like .vscode, .github unless user wants them
      if (!includeHidden && entry.name.startsWith('.') && entry.isDirectory()) {
        onEntry({ kind: 'dir-ignored', path: abs, rel, reason: 'hidden' });
        continue;
      }

      // dont follow symlinks,,, theyre trouble
      if (entry.isSymbolicLink()) {
        onEntry({ kind: 'symlink', path: abs, rel });
        continue;
      }

      // if its a directory, recurse into it (unless ignored)
      if (entry.isDirectory()) {
        if (ig.ignores(rel + '/')) {
          onEntry({ kind: 'dir-ignored', path: abs, rel });
          continue;
        }
        walkDir(abs);
        continue;
      }

      // if its a file, decide if we care about it
      if (entry.isFile()) {
        if (ig.ignores(rel)) {  // gitignore says skip
          onEntry({ kind: 'file-ignored', path: abs, rel });
          continue;
        }
        const category = getCategory(entry.name);
        if (HARD_SKIP.has(category)) {  // definitely skip (binary, archive, font)
          onEntry({ kind: 'file-ignored', path: abs, rel, reason: category });
          continue;
        }
        if (SKIP_CATEGORIES.has(category)) {  // user said skip this category
          onEntry({ kind: 'file-ignored', path: abs, rel, reason: category });
          continue;
        }
        onEntry({ kind: 'file', path: abs, rel });  // we want this file!
      }
    }
  }

  // start the adventure from the repo root
  walkDir(repoPath);
}









/* ------------------------------------------------------------------ */
/* Hashing                                                             */
/* ------------------------------------------------------------------ */

// quick , dirty and sexy md5 hash for file contents,,, used for caching 
// like we dont summarize each time,,, we check hash,, if same,, we dont do the whole thing on an unchanged file,,, this tracks changes
function md5Buffer(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Packages                                                            */
/* ------------------------------------------------------------------ */

// safely read a JSON file,,, returns null if anything goes wrong
function safeReadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_e) {
    return null;
  }
}

// turn a package name into a safe ID
// @scope/foo becomes pkg_scope_foo
function packageId(name) {
  return 'pkg_' + name.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
}

// collects all npm packages from package.json
// looks at dependencies, devDependencies, peerDependencies, optionalDependencies
function collectPackages(repoPath) {
  const pkgs = [];       // all packages we find
  const seen = new Set();  // track what weve seen to avoid duplicates
  const pkgJsonPath = path.join(repoPath, 'package.json');
  const pkgJson = safeReadJSON(pkgJsonPath);
  if (!pkgJson) return pkgs;  // no package.json, no packages

  // all the places dependencies can live in package.json
  const sources = [
    ['dependencies', pkgJson.dependencies],
    ['devDependencies', pkgJson.devDependencies],
    ['peerDependencies', pkgJson.peerDependencies],
    ['optionalDependencies', pkgJson.optionalDependencies],
  ];

  // go through each bucket and collect packages
  for (const [bucket, deps] of sources) {
    if (!deps) continue;  // skip empty buckets
    for (const [name, declared] of Object.entries(deps)) {
      if (seen.has(name)) continue;  // already got this one
      seen.add(name);
      // try to get the actually installed version
      const installed = safeReadJSON(path.join(repoPath, 'node_modules', name, 'package.json'));
      pkgs.push({
        id: packageId(name),
        name,
        version: installed && installed.version ? installed.version : declared,
        declared_version: declared,
        type: 'external_package',
        dependency_type: bucket,
        location: `node_modules/${name}`,
      });
    }
  }

  return pkgs;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */


//THE MAIN EVENT  (btw,,, I didnt writ this comment below,,,,, wtf is even this paragraph down here)
/**
 * 
 * Scan a repository and produce a structural map.
 *
 * @param {string} repoPathInput repository path (relative or absolute)
 * @param {object} [options]
 * @param {(message: string) => void} [options.onProgress] progress callback
 * @param {(level: 'warn'|'error', message: string) => void} [options.onLog]
 * @param {boolean} [options.includeHidden] include dot-folders (default: false)
 * @param {boolean} [options.includeDocs] include docs/database files (default: false)
 * @param {boolean} [options.includeMedia] include media files (default: false)
 * @param {boolean} [options.aggressive] only process code files, skip config/style/media/docs (default: true)
 * @returns {Promise<object>} the map object
 */
//can't believe this thing above is a comment and not code

async function scan(repoPathInput, options = {}) {
  // setup callbacks and options
  const onProgress = options.onProgress || (() => {});
  const onLog = options.onLog || (() => {});
  const walkOptions = {
    includeHidden: options.includeHidden,
    includeDocs: options.includeDocs,
    includeMedia: options.includeMedia,
    aggressive: options.aggressive !== false, // default true cuz speed is king
  };

  // validate the repo path
  const repoPath = path.resolve(repoPathInput || '.');
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }
  if (!fs.statSync(repoPath).isDirectory()) {
    throw new Error(`Repository path is not a directory: ${repoPath}`);
  }

  onProgress(`Loading .gitignore patterns from ${repoPath}`);
  const ig = loadIgnore(repoPath);  // load gitignore patterns

  const files = [];        // all files we scan
  let analyzed = 0;        // how many we actually analyzed
  let ignored = 0;         // how many we skipped
  let fileCounter = 1;     // for generating file IDs
  // cache for parsed AST results,,, same hash = same result = dont parse again
  const parseCache = new Map();

  // walk the repo and process each file
  walkRepository(repoPath, ig, (entry) => {
    if (entry.kind === 'dir-ignored' || entry.kind === 'file-ignored') {
      ignored++;
      return;
    }
    if (entry.kind === 'symlink') {
      onLog('warn', `Skipping symlink: ${entry.rel}`);
      return;
    }
    if (entry.kind === 'error') {
      onLog('warn', `Cannot read directory ${entry.path}: ${entry.error.message}`);
      return;
    }
    if (entry.kind !== 'file') return;  // only care about actual files

    // read the file and get its stats
    let stat;
    let buffer;
    try {
      stat = fs.statSync(entry.path);
      buffer = fs.readFileSync(entry.path);
    } catch (err) {
      onLog('warn', `Cannot read ${entry.rel}: ${err.message}`);
      return;
    }

    // create the file object with all its metadata
    const id = `file_${String(fileCounter++).padStart(3, '0')}`;
    const name = path.basename(entry.path);
    const category = getCategory(name);
    const language = getLanguage(name);
    const hash = md5Buffer(buffer);  // for caching and change detection

    // build the file object,,, this goes into the map.json
    const fileObj = {
      id,
      name,
      path: entry.rel,
      type: category,
      language,
      size_bytes: stat.size,
      hash,
      description: '',         // filled in by AI later
      functions: [],           // extracted from code
      imports: [],             // what this file imports
      exported: [],            // what this file exports
      last_modified: stat.mtime.toISOString(),
      importance_score: 0,     // calculated later by mapper
      usage_count: 0,          // how many files import this
      summarizable: category === 'code',  // only code files get AI summaries
    };

    // if its code, parse it and extract all the good stuff
    if (category === 'code') {
      const cached = parseCache.get(hash);
      if (cached) {
        // weve seen this exact file before,,, use cached result
        fileObj.functions = cached.items;
        fileObj.imports = cached.imports;
        fileObj.exported = cached.exports;
      } else {
        try {
          const text = buffer.toString('utf8');
          const ast = parseSource(text, name);
          const extracted = extractFromAst(ast, text, id);
          fileObj.functions = extracted.items;
          fileObj.imports = extracted.imports;
          fileObj.exported = extracted.exports;
          parseCache.set(hash, extracted);  // cache for next time
        } catch (err) {
          onLog('warn', `Failed to parse ${entry.rel}: ${err.message}`);
        }
      }
    }

    files.push(fileObj);
    analyzed++;
    if (analyzed % 50 === 0) onProgress(`Scanned ${analyzed} files...`);
  }, walkOptions);

  onProgress('Collecting packages from package.json');
  const packages = collectPackages(repoPath);

  onProgress('Enriching file metadata (env vars, tags, routes)...');
  // temporarily add full content for enrichment phase
  const filesWithContent = files.map(f => {
    if (f.type !== 'code' || !f.path) return f;
    try {
      const fullPath = path.join(repoPath, f.path);
      if (fs.existsSync(fullPath)) {
        f.content = fs.readFileSync(fullPath, 'utf8');
      }
    } catch {
      // ignore read errors
    }
    return f;
  });
  enrichFiles(filesWithContent, { includeContent: true });  // add extra metadata

  // return the complete map structure
  return {
    metadata: {
      timestamp: new Date().toISOString(),
      repo_path: repoPath,
      files_analyzed: analyzed,
      files_ignored: ignored,
      files_summarizable: files.filter(f => f.summarizable).length,
      format_version: FORMAT_VERSION,
    },
    files: filesWithContent,
    packages,
    networks: [],         // filled in by mapper.js (which is a behimith on it's own)
    links: [],            // filled in by mapper.js
    circular_dependencies: [],  // filled in by mapper.js
    statistics: {},       // filled in by mapper.js
  };
}

module.exports = {
  scan,
  // Exposed for tests / advanced users (like me,, any my buddy AI):
  parseSource,
  extractFromAst,
  getCategory,
  getLanguage,
  md5Buffer,
  collectPackages,
  walkRepository,
  FORMAT_VERSION,
};
