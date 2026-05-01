'use strict';

// express server for the 3D visualization
// serves static files and API endpoints for the graph data

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { search } = require('./search');
const { loadFullMap, searchFiles } = require('../core/storage');

const DEFAULT_PORT = 8689;
const PUBLIC_DIR = path.join(__dirname, 'public');
















/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

// loads map from split storage, throws helpful error if not found
function loadMap(repoPath, outDir) {
  const map = loadFullMap(repoPath, outDir);
  if (!map) {
    // Fallback to old map.json
    const oldPath = path.join(repoPath, outDir || '.reporose', 'map.json');
    if (fs.existsSync(oldPath)) {
      return JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    }
    const err = new Error(
      `Cannot find index.json. Run "reporose analyze" first.`,
    );
    err.code = 'ENOENT';
    throw err;
  }
  return map;
}

// builds detailed info for a file node including connections
function buildFileDetail(map, file) {
  const incoming = [];
  const outgoing = [];
  const packagesUsed = [];

  for (const link of map.links || []) {
    if (link.to_file_id === file.id) {
      const fromFile = map.files.find((f) => f.id === link.from_file_id);
      if (fromFile) {
        incoming.push({
          file_id: fromFile.id,
          name: fromFile.name,
          path: fromFile.path,
          type: link.type,
          weight: link.weight,
          frequency: link.frequency,
        });
      }
    }
    if (link.from_file_id === file.id && link.to_file_id) {
      const toFile = map.files.find((f) => f.id === link.to_file_id);
      if (toFile) {
        outgoing.push({
          file_id: toFile.id,
          name: toFile.name,
          path: toFile.path,
          type: link.type,
          weight: link.weight,
          frequency: link.frequency,
        });
      }
    }
    if (link.from_file_id === file.id && link.to_package_id) {
      const pkg = (map.packages || []).find((p) => p.id === link.to_package_id);
      if (pkg) {
        packagesUsed.push({
          package_id: pkg.id,
          name: pkg.name,
          version: pkg.version,
          frequency: link.frequency,
        });
      }
    }
  }

  return {
    kind: 'file',
    ...file,
    connections: {
      incoming,
      outgoing,
      packages_used: packagesUsed,
    },
  };
}

// builds detailed info for a function node
function buildFunctionDetail(map, file, fn) {
  return {
    kind: 'function',
    ...fn,
    file: {
      file_id: file.id,
      name: file.name,
      path: file.path,
      language: file.language,
    },
  };
}

// finds any node by id (file, function, or package)
function findNode(map, id) {
  for (const file of map.files || []) {
    if (file.id === id) return buildFileDetail(map, file);
    for (const fn of file.functions || []) {
      if (fn.id === id) return buildFunctionDetail(map, file, fn);
    }
  }
  for (const pkg of map.packages || []) {
    if (pkg.id === id) {
      const importers = (map.links || [])
        .filter((l) => l.to_package_id === pkg.id)
        .map((l) => {
          const f = (map.files || []).find((file) => file.id === l.from_file_id);
          return f ? { file_id: f.id, name: f.name, path: f.path } : null;
        })
        .filter(Boolean);
      return { kind: 'package', ...pkg, importers };
    }
  }
  return null;
}
















/* ------------------------------------------------------------------ */
/* App factory                                                         */
/* ------------------------------------------------------------------ */

// creates the express app with all routes and middleware
function createApp(options = {}) {
  const app = express();
  const repoPath = options.repoPath || process.cwd();
  const outDir = options.outDir || '.reporose';
  const publicDir = options.publicDir || PUBLIC_DIR;
  const loader = options.loader || (() => loadMap(repoPath, outDir));

  // CORS headers so browser doesnt complain
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // log API requests (skipped for static files in silent mode)
  app.use((req, _res, next) => {
    if (!options.silent && req.path.startsWith('/api/')) {
      if (options.onLog) {
        options.onLog(req.method, req.url);
      } else {
        // eslint-disable-next-line no-console
        console.log(`[reporose-server] ${req.method} ${req.url}`);
      }
    }
    next();
  });

  // ----- API routes ------------------------------------------------

  // health check
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // get the full map.json
  app.get('/api/graph', (_req, res, next) => {
    try {
      res.json(loader());
    } catch (err) {
      next(err);
    }
  });

  // search endpoint for the autocomplete
  app.get('/api/search', (req, res, next) => {
    try {
      const map = loader();
      const q = String(req.query.q || '').slice(0, 200);
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const result = search(map, q, { limit });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // get detailed info for a specific node
  app.get('/api/node/:id', (req, res, next) => {
    try {
      const map = loader();
      const node = findNode(map, req.params.id);
      if (!node) {
        return res.status(404).json({ error: 'not_found', id: req.params.id });
      }
      res.json(node);
    } catch (err) {
      next(err);
    }
  });

  // query endpoint for AI agents - search and get full file data
  app.get('/api/query', (req, res, next) => {
    try {
      const q = String(req.query.q || '').slice(0, 200);
      const limit = Math.min(20, req.query.limit ? Number(req.query.limit) : 5);
      const includeFull = req.query.full !== 'false';
      
      const matches = searchFiles(repoPath, q, outDir, { limit, includeFull });
      
      res.json({
        query: q,
        count: matches.length,
        results: matches,
      });
    } catch (err) {
      next(err);
    }
  });

  // get full file data by path
  app.get('/api/file/*', (req, res, next) => {
    try {
      const filePath = req.params[0];
      const file = getFileByPath(repoPath, filePath, outDir);
      
      if (!file) {
        return res.status(404).json({ error: 'not_found', path: filePath });
      }
      res.json(file);
    } catch (err) {
      next(err);
    }
  });

  // ----- Static frontend ------------------------------------------

  // serve the HTML/CSS/JS files
  app.use(express.static(publicDir, { fallthrough: true, maxAge: 0 }));

  app.get('/', (_req, res, next) => {
    const indexFile = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
    next();
  });

  // 404 handler
  app.use((req, res, _next) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // generic error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (!options.silent) {
      if (options.onError) {
        options.onError(req.method, req.url, err.message);
      } else {
        // eslint-disable-next-line no-console
        console.error(`[reporose-server] error on ${req.method} ${req.url}:`, err.message);
      }
    }
    const status = err.status || (err.code === 'ENOENT' ? 503 : 500);
    res.status(status).json({ error: err.code || 'internal_error', message: err.message });
  });

  return app;
}
















/* ------------------------------------------------------------------ */
/* Port helpers                                                        */
/* ------------------------------------------------------------------ */

// tries to listen on a port, returns promise that resolves with actual port
function tryListen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// tries desiredPort, then keeps incrementing until it finds a free one
async function listenWithFallback(server, desiredPort, host, maxAttempts = 20) {
  if (desiredPort === 0) return tryListen(server, 0, host);
  let port = desiredPort;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await tryListen(server, port, host);
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      port += 1;
    }
  }
  throw new Error(`No free port found in range ${desiredPort}..${desiredPort + maxAttempts - 1}`);
}

// main entry point — creates app and starts listening
async function start(options = {}) {
  const app = createApp(options);
  const server = http.createServer(app);
  const host = options.host || '127.0.0.1';
  const port = await listenWithFallback(server, options.port == null ? DEFAULT_PORT : options.port, host);
  const url = `http://${host}:${port}`;
  return { server, app, port, url };
}

module.exports = {
  createApp,
  start,
  buildFileDetail,
  buildFunctionDetail,
  findNode,
  listenWithFallback,
  loadMap,
  DEFAULT_PORT,
  PUBLIC_DIR,
};
