'use strict';

/**
 Phase 2: Dependency Mapper,,, the heavy lifter of this whole operation

 So like,,, we take that Phase-1 map (you know, the one scanner.js made)
 and we turn it into something actually useful:
   - links[]                 (who talks to who)
   - circular_dependencies[] (those nasty circular imports that ruin your day)
   - networks[]              (groups of files that hang out together)
   - statistics{}            (numbers for nerds)
   - importance_score        (how critical is this file really)
   - usage_count             (how many ppl import this thing)

 Basically this thing figures out the "social network" of your code

 Algorithms used (fancy words incoming):
   - Tarjan's SCC (finds those circular dependency circles)
   - BFS 2-hop thing (who knows who knows who)
   - Brandes' algorithm (whos the popular kid in codebase high school)
   - BFS networks (finding cliques)
 */

const path = require('path');

// these are the ONLY extensions we care about for code files
const CODE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// weights for different types of connections
// higher = more important basically
const WEIGHTS = {
  DIRECT: 100,     // file A imports file B directly
  INDIRECT: 50,     // file A imports file B which imports file C (2 hops)
  PACKAGE: 80,      // importing from node_modules
  CIRCULAR: 200,    // BAD BAD BAD circular dependencies get highest weight cuz theyre trouble
};
















/* ------------------------------------------------------------------ */
/* Indexing helpers                                                    */
/* ------------------------------------------------------------------ */

// builds a lookup table so we can find files by path real quick
function buildFileIndex(files) {
  const byPath = new Map();
  for (const f of files) byPath.set(f.path, f);  // path -> file object
  return byPath;
}

// same thing but for npm packages
function buildPackageIndex(packages) {
  const byName = new Map();
  for (const p of packages) byName.set(p.name, p);  // package name -> package object
  return byName;
}

// cleams up paths so they match properly
// like ./utils/helpers becomes utils/helpers
// and /absolute/path becomes absolute/path
function normalizeRel(p) {
  let n = path.posix.normalize(p);
  if (n.startsWith('./')) n = n.slice(2);
  if (n.startsWith('/')) n = n.slice(1);
  return n;
}

/**
 Tries to figure out what file youre actually importing
 like if you write import './utils/helpers',,
 it tries:
   - utils/helpers (exact)
   - utils/helpers.js (with extension)
   - utils/helpers/index.js (index fallback)
 
 basically handles all the ways JS/TS lets you import stuff
 */
function resolveFileImport(byPath, fromFilePath, importSource) {
  const fromDir = path.posix.dirname(fromFilePath);
  const joined = path.posix.join(fromDir, importSource);
  const target = normalizeRel(joined);
  if (byPath.has(target)) return byPath.get(target);
  for (const ext of CODE_EXTS) {
    if (byPath.has(target + ext)) return byPath.get(target + ext);
  }
  for (const ext of CODE_EXTS) {
    if (byPath.has(target + '/index' + ext)) return byPath.get(target + '/index' + ext);
  }
  return null;
}

/**
 Finds what npm package youre importing from
 handles scoped packages like @babel/parser
 and sub-paths like lodash/fp
 */
function findPackageForImport(packageIndex, importSource) {
  if (packageIndex.has(importSource)) return packageIndex.get(importSource);
  const parts = importSource.split('/');
  if (importSource.startsWith('@') && parts.length >= 2) {
    const name = parts.slice(0, 2).join('/');
    if (packageIndex.has(name)) return packageIndex.get(name);
  } else if (parts.length >= 1 && packageIndex.has(parts[0])) {
    return packageIndex.get(parts[0]);
  }
  return null;
}
















/* ------------------------------------------------------------------ */
/* Direct + package links                                              */
/* ------------------------------------------------------------------ */

// makes IDs for links like link_0001, link_0002,,, you get the idea
function makeIdGenerator() {
  let n = 1;
  return () => `link_${String(n++).padStart(4, '0')}`;
}

// this is where we figure out who imports who
// like detective work but for code,,, finding all the relationships
// we look at every file and track what it imports (both other files and npm packages)
function buildDirectLinks(map, byPath, packageIndex, nextLinkId) {
  // use Maps so we can dedupe links
  // same file importing same target multiple times = one link with higher frequency
  const fileLinkMap = new Map();     // key: "fileA->fileB", value: link object
  const packageLinkMap = new Map();  // key: "fileA->packageX", value: link object

  // iterate through every file in the map
  for (const file of map.files) {
    // check all imports of this file
    // each import tells us this file depends on something else
    for (const imp of file.imports || []) {
      
      if (imp.type === 'file') {
        // this file imports another file from the same project
        // like import './utils/helpers' or import '../config'
        const target = resolveFileImport(byPath, file.path, imp.source);
        if (!target) {
          // couldnt resolve the import,,, maybe:
          // - file doesnt exist
          // - its a dynamic import we couldnt track
          // - its imported from a place we didnt scan
          continue;
        }
        
        // make a unique key for this import relationship
        // we use this to dedupe if same file imports same target multiple times
        const key = `${file.id}->${target.id}`;
        let link = fileLinkMap.get(key);
        
        if (!link) {
          // first time seeing this pair,,, create the link
          link = {
            id: nextLinkId(),
            from_file_id: file.id,
            from_function_id: null,
            to_file_id: target.id,
            to_function_id: null,
            type: 'direct',
            location: { file: file.path, line: imp.line_imported },
            frequency: 0,
            weight: 0,
            is_circular: false,
          };
          fileLinkMap.set(key, link);
        }
        // increment frequency cuz this import happened again
        // (same file importing same thing multiple times is weird but possible)
        link.frequency += 1;
        
      } else if (imp.type === 'package') {
        // this file imports from npm/node_modules
        // like import lodash from 'lodash' or import { parser } from '@babel/parser'
        const pkg = findPackageForImport(packageIndex, imp.source);
        if (!pkg) {
          // package not found,,, maybe:
          // - its not in package.json
          // - its a builtin module like 'fs' or 'path'
          // - its a typo in the import
          continue;
        }
        
        const key = `${file.id}->${pkg.id}`;
        let link = packageLinkMap.get(key);
        
        if (!link) {
          // first time this file imports from this package
          link = {
            id: nextLinkId(),
            from_file_id: file.id,
            from_function_id: null,
            to_package_id: pkg.id,
            to_file_id: null,
            to_function_id: null,
            type: 'package',
            location: { file: file.path, line: imp.line_imported },
            frequency: 0,
            weight: 0,
          };
          packageLinkMap.set(key, link);
        }
        link.frequency += 1;
      }
    }
  }

  // now that we know how many times each link happens,,, calculate weight
  // more imports = more important connection = higher weight
  for (const link of fileLinkMap.values()) {
    link.weight = WEIGHTS.DIRECT * link.frequency;
  }

  // convert Maps to arrays for the final result
  return {
    fileLinks: [...fileLinkMap.values()],
    packageLinks: [...packageLinkMap.values()],
  };
}
















/* ------------------------------------------------------------------ */
/* Tarjan's SCC for cycle detection                                    */
/* ------------------------------------------------------------------ */

/**
Tarjan's Strongly Connected Components algorithm

okay so this is fancy computer science stuff,,, but basically:
- we have a bunch of files (nodes)
- some files import other files (edges)
- we wanna find "strongly connected components" = groups where every file
  can reach every other file in the group by following imports

in simpler terms: find circles in your import graph
like A imports B, B imports C, C imports A = thats a cycle = bad news

this is the iterative version so we dont blow the call stack
on huge codebases (recursive version would crash on big projects)

the algorithm uses DFS (depth first search) and tracks two numbers:
- index: when did we first visit this node
- lowlink: the lowest index reachable from this node

if lowlink === index, we found the root of a strongly connected component
and we pop everything off the stack until we hit that root

@param {string[]} nodes - array of file IDs
@param {Map<string, string[]>} adj - adjacency list: file -> files it imports
@returns {string[][]} array of SCCs, each SCC is array of file IDs
 */
function findSCCs(nodes, adj) {
  // index of each node (when we first discovered it)
  const indices = new Map();
  // lowlink of each node (lowest index reachable from here)
  const lowlinks = new Map();
  // which nodes are currently on our DFS stack
  const onStack = new Set();
  // the actual stack for DFS
  const stack = [];
  // all the strongly connected components we found
  const sccs = [];
  // counter for assigning discovery order
  let index = 0;

  // iterate through all nodes as potential starting points
  for (const start of nodes) {
    if (indices.has(start)) continue;  // already visited, skip
    
    // start a new DFS from this node
    // work stack simulates recursion: { node, neighbors array, current index in neighbors }
    const work = [{ node: start, neighbors: adj.get(start) || [], i: 0 }];
    
    // initialize the start node
    indices.set(start, index);
    lowlinks.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);
    
    // main DFS loop - process until work stack is empty
    while (work.length) {
      const frame = work[work.length - 1];  // peek at top of stack
      const v = frame.node;
      
      // if there are more neighbors to process
      if (frame.i < frame.neighbors.length) {
        const w = frame.neighbors[frame.i++];  // get next neighbor and advance counter
        
        if (!indices.has(w)) {
          // w is undiscovered! this is a tree edge
          // discover w and push it onto work stack
          indices.set(w, index);
          lowlinks.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, neighbors: adj.get(w) || [], i: 0 });
          
        } else if (onStack.has(w)) {
          // w is on stack - this is a back edge! we found a cycle
          // update lowlink of v to be the minimum of current lowlink and w's index
          lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)));
        }
        // if w is already discovered but not on stack, its a cross edge - ignore it
        
      } else {
        // finished processing all neighbors of v
        // check if v is the root of an SCC
        if (lowlinks.get(v) === indices.get(v)) {
          // yes! v is the root - pop everything until we hit v
          const scc = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            scc.push(w);
          } while (w !== v);
          sccs.push(scc);
        }
        
        // pop current frame from work stack
        work.pop();
        
        // if there's a parent, update its lowlink
        if (work.length) {
          const parent = work[work.length - 1].node;
          lowlinks.set(parent, Math.min(lowlinks.get(parent), lowlinks.get(v)));
        }
      }
    }
  }
  
  return sccs;  // all the strongly connected components we found
}

// takes the raw SCCs from Tarjan and turns them into proper cycle reports
// also marks all the links inside cycles as circular so we can show them in the UI
// 
// what is a circular dependency? 
// its when file A imports file B, and somehow through a chain of imports,
// file B (or something B imports) ends up importing back to file A
// 
// this is bad because:
// - it makes code harder to understand
// - it can cause infinite loops in bundlers
// - it makes testing harder
// - its just messy, dont do it
function detectCircularDependencies(map, fileLinks) {
  // build adjacency list: file -> files it imports
  // this is the graph well run Tarjan's algorithm on
  const adj = new Map();
  for (const f of map.files) adj.set(f.id, []);
  for (const link of fileLinks) {
    if (adj.has(link.from_file_id) && adj.has(link.to_file_id)) {
      adj.get(link.from_file_id).push(link.to_file_id);
    }
  }

  // run Tarjan's algorithm to find all strongly connected components
  const sccs = findSCCs([...adj.keys()], adj);
  const cycles = [];
  let cycleCounter = 1;

  // process each SCC to see if its actually a cycle
  for (const scc of sccs) {
    // an SCC is a cycle if:
    // 1. it has more than 1 node (A imports B imports A)
    // 2. OR it has 1 node that imports itself (A imports A)
    let isCycle = false;
    if (scc.length > 1) {
      isCycle = true;
    } else {
      const v = scc[0];
      if ((adj.get(v) || []).includes(v)) isCycle = true;
    }
    
    // not a cycle, just a lonely file by itself
    if (!isCycle) continue;

    // collect info about which files are in this cycle
    const sccSet = new Set(scc);
    const filesInvolved = scc.map((fid) => {
      // find the link from this file to another file in the cycle
      // we use this to get the line number for reporting
      const link = fileLinks.find(
        (l) => l.from_file_id === fid && sccSet.has(l.to_file_id),
      );
      return {
        file_id: fid,
        line: link && link.location ? link.location.line : null,
      };
    });

    // create the cycle report object
    const cycleId = `cycle_${String(cycleCounter++).padStart(3, '0')}`;
    cycles.push({
      id: cycleId,
      cycle: [...scc],
      risk_level: 'high',
      files_involved: filesInvolved,
      recommendation: 'Extract shared logic into a separate module to break the cycle.',
    });

    // mark every link inside this SCC as circular and give it heavy weight
    // so the visualization can highlight these bad connections
    for (const link of fileLinks) {
      if (sccSet.has(link.from_file_id) && sccSet.has(link.to_file_id)) {
        link.is_circular = true;
        link.type = 'circular';
        link.weight = WEIGHTS.CIRCULAR;
      }
    }
  }

  return cycles;
}
















/* ------------------------------------------------------------------ */
/* Indirect (2-hop) expansion                                          */
/* ------------------------------------------------------------------ */

// finds "friends of friends" in your code
// if A imports B and B imports C,,, then A is indirectly connected to C
function computeIndirectLinks(fileLinks, nextLinkId) {
  // build adjacency: from -> Map<to, frequency>
  const adj = new Map();
  for (const link of fileLinks) {
    if (!adj.has(link.from_file_id)) adj.set(link.from_file_id, new Map());
    adj.get(link.from_file_id).set(link.to_file_id, link.frequency);
  }

  // find all A -> B -> C paths where A !== C
  // accumulate frequency cuz there might be multiple paths
  const indirect = new Map();
  for (const [a, bMap] of adj) {
    for (const b of bMap.keys()) {
      const cMap = adj.get(b);
      if (!cMap) continue;
      for (const c of cMap.keys()) {
        if (c === a) continue;  // self-reference is circular territory
        const key = `${a}->${c}`;
        if (!indirect.has(key)) indirect.set(key, { from: a, to: c, frequency: 0 });
        indirect.get(key).frequency += 1;
      }
    }
  }

  // skip pairs that already have direct links (direct is king, indirect is the peasant)
  const directKeys = new Set(fileLinks.map((l) => `${l.from_file_id}->${l.to_file_id}`));

  const indirectLinks = [];
  for (const [key, data] of indirect) {
    if (directKeys.has(key)) continue;  // already got a direct, skip
    indirectLinks.push({
      id: nextLinkId(),
      from_file_id: data.from,
      from_function_id: null,
      to_file_id: data.to,
      to_function_id: null,
      type: 'indirect',
      location: null,
      frequency: data.frequency,
      weight: WEIGHTS.INDIRECT * data.frequency,
      is_circular: false,
    });
  }

  return indirectLinks;
}
















/* ------------------------------------------------------------------ */
/* Brandes' betweenness centrality (directed, unweighted)              */
/* ------------------------------------------------------------------ */

// calculates betweenness centrality: which files are the "bridges" in your codebase
// high score = this file connects otherwise disconnected parts of your code
// basically the socialite of your codebase
function betweennessCentrality(nodes, adj) {
  const CB = new Map();
  for (const v of nodes) CB.set(v, 0);

  // for each node as source, do BFS and accumulate
  for (const s of nodes) {
    const stack = [];
    const P = new Map();     // predecessors
    const sigma = new Map(); // number of shortest paths
    const dist = new Map();  // distances
    for (const v of nodes) { P.set(v, []); sigma.set(v, 0); dist.set(v, -1); }
    sigma.set(s, 1); dist.set(s, 0);

    // BFS to find shortest paths from source s to all others
    const queue = [s]; let head = 0;
    while (head < queue.length) {
      const v = queue[head++];
      stack.push(v);
      for (const w of adj.get(v) || []) {
        if (dist.get(w) < 0) { dist.set(w, dist.get(v) + 1); queue.push(w); }
        if (dist.get(w) === dist.get(v) + 1) {
          sigma.set(w, sigma.get(w) + sigma.get(v));
          P.get(w).push(v);
        }
      }
    }

    // backpropagate dependency scores
    const delta = new Map();
    for (const v of nodes) delta.set(v, 0);
    while (stack.length) {
      const w = stack.pop();
      for (const v of P.get(w)) {
        delta.set(v, delta.get(v) + (sigma.get(v) / sigma.get(w)) * (1 + delta.get(w)));
      }
      if (w !== s) CB.set(w, CB.get(w) + delta.get(w));
    }
  }

  return CB;  // betweenness centrality for each node
}
















/* ------------------------------------------------------------------ */
/* Importance score                                                    */
/* ------------------------------------------------------------------ */

// calculates how important each file is in your codebase
// based on: incoming connections (who imports this), outgoing connections (who this imports),
// usage frequency, and betweenness centrality
function computeImportance(map, fileLinks, packageLinks) {
  // init counters for each file
  const incoming = new Map();   // how many files import this
  const outgoing = new Map();   // how many files this one imports
  const usageCount = new Map(); // how many times this file gets imported
  for (const f of map.files) {
    incoming.set(f.id, 0);
    outgoing.set(f.id, 0);
    usageCount.set(f.id, 0);
  }

  // only direct/circular links count for these metrics
  for (const link of fileLinks) {
    if (link.type === 'indirect') continue;
    incoming.set(link.to_file_id, (incoming.get(link.to_file_id) || 0) + 1);
    outgoing.set(link.from_file_id, (outgoing.get(link.from_file_id) || 0) + 1);
    usageCount.set(
      link.to_file_id,
      (usageCount.get(link.to_file_id) || 0) + link.frequency,
    );
  }

  // build adjacency list for centrality calc
  const adj = new Map();
  for (const f of map.files) adj.set(f.id, []);
  for (const link of fileLinks) {
    if (link.type === 'indirect') continue;
    adj.get(link.from_file_id).push(link.to_file_id);
  }
  const cb = betweennessCentrality([...adj.keys()], adj);

  // phase 1: compute raw importance scores
  // formula weights: incoming (1.2), outgoing (0.8), usage (0.5), centrality (1.5)
  const rawScores = new Map();
  for (const f of map.files) {
    const inc = incoming.get(f.id) || 0;
    const out = outgoing.get(f.id) || 0;
    const usage = usageCount.get(f.id) || 0;
    const bc = cb.get(f.id) || 0;
    const raw = inc * 1.2 + out * 0.8 + usage * 0.5 + bc * 1.5;
    rawScores.set(f.id, raw);
  }

  // phase 2: propagate importance transitively
  // entry point files (like main.js) might import critical files but have no importers themselves
  // so we boost them based on the importance of what they import
  for (let iter = 0; iter < 3; iter++) {
    for (const f of map.files) {
      const targets = adj.get(f.id) || [];
      if (targets.length === 0) continue;
      let targetSum = 0;
      for (const t of targets) targetSum += rawScores.get(t) || 0;
      const avgTarget = targetSum / targets.length;
      // boost = 40% of avg target importance, decaying each iteration
      const boost = avgTarget * 0.4 * Math.pow(0.6, iter);
      rawScores.set(f.id, rawScores.get(f.id) + boost);
    }
  }

  // find max for scaling
  let maxRaw = 0;
  for (const raw of rawScores.values()) {
    if (raw > maxRaw) maxRaw = raw;
  }

  // scale everything to 0-10 range and save to file objects
  for (const f of map.files) {
    const raw = rawScores.get(f.id);
    const scaled = maxRaw > 0 ? (raw / maxRaw) * 10 : 0;
    f.importance_score = Math.round(scaled * 10) / 10;
    f.usage_count = usageCount.get(f.id) || 0;
    f.incoming_connections = incoming.get(f.id) || 0;
    f.outgoing_connections = outgoing.get(f.id) || 0;
    f.betweenness_centrality = Math.round((cb.get(f.id) || 0) * 100) / 100;
  }

  // also compute usage for packages
  const pkgUsage = new Map();
  for (const link of packageLinks) {
    pkgUsage.set(link.to_package_id, (pkgUsage.get(link.to_package_id) || 0) + link.frequency);
  }
  for (const pkg of map.packages) {
    pkg.usage_count = pkgUsage.get(pkg.id) || 0;
  }
  for (const link of packageLinks) {
    const usage = pkgUsage.get(link.to_package_id) || 0;
    link.weight = WEIGHTS.PACKAGE * usage;
  }
}
















/* ------------------------------------------------------------------ */
/* Networks (weakly connected components)                              */
/* ------------------------------------------------------------------ */

// finds "clusters" of files that are all connected to each other
// like islands in your codebase
// main codebase vs isolated files nobody imports
function buildNetworks(map, fileLinks) {
  // build bidirectional neighbor map (undirected for connected components)
  const neighbors = new Map();
  for (const f of map.files) neighbors.set(f.id, new Set());
  for (const link of fileLinks) {
    if (link.type === 'indirect') continue;
    if (neighbors.has(link.from_file_id) && neighbors.has(link.to_file_id)) {
      neighbors.get(link.from_file_id).add(link.to_file_id);
      neighbors.get(link.to_file_id).add(link.from_file_id);
    }
  }

  // find connected components using DFS
  const visited = new Set();
  const components = [];
  for (const f of map.files) {
    if (visited.has(f.id)) continue;
    const comp = [];
    const stack = [f.id];
    visited.add(f.id);
    while (stack.length) {
      const v = stack.pop();
      comp.push(v);
      for (const w of neighbors.get(v) || []) {
        if (!visited.has(w)) { visited.add(w); stack.push(w); }
      }
    }
    components.push(comp);
  }

  // separate isolated files from the main group
  const isolated = [];
  const connected = [];
  for (const comp of components) {
    if (comp.length === 1 && neighbors.get(comp[0]).size === 0) {
      isolated.push(comp[0]);
    } else {
      connected.push(...comp);
    }
  }

  // build the networks array
  const networks = [];
  if (connected.length > 0) {
    const connectedSet = new Set(connected);
    let edgeCount = 0;
    for (const link of fileLinks) {
      if (link.type === 'indirect') continue;
      if (connectedSet.has(link.from_file_id) && connectedSet.has(link.to_file_id)) {
        edgeCount += 1;
      }
    }
    networks.push({
      id: 'network_main',
      name: 'Main Codebase',
      type: 'active',
      node_count: connected.length,
      edge_count: edgeCount,
      files: connected,
    });
  }

  if (isolated.length > 0) {
    networks.push({
      id: 'network_isolated',
      name: 'Unused Files',
      type: 'isolated',
      node_count: isolated.length,
      edge_count: 0,
      files: isolated,
    });
  }

  return networks;
}
















/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

// computes nerdy numbers for the dashboard
// total files, functions, connections, network density, etc.
function computeStatistics(map, fileLinks, packageLinks) {
  const totalFiles = map.files.length;
  const totalFunctions = map.files.reduce((acc, f) => acc + (f.functions ? f.functions.length : 0), 0);
  const totalConnections = map.links.length;
  const directOnly = fileLinks.filter((l) => l.type !== 'indirect').length;
  const possibleEdges = totalFiles * (totalFiles - 1);
  const networkDensity = possibleEdges > 0 ? directOnly / possibleEdges : 0;

  // find the most important file
  let mostImportant = null;
  let totalImportance = 0;
  for (const f of map.files) {
    const score = f.importance_score || 0;
    totalImportance += score;
    if (!mostImportant || score > mostImportant.importance) {
      mostImportant = { file_id: f.id, importance: score };
    }
  }
  const avgImportance = totalFiles > 0 ? totalImportance / totalFiles : 0;

  return {
    total_files: totalFiles,
    total_functions: totalFunctions,
    total_connections: totalConnections,
    circular_dependency_count: map.circular_dependencies.length,
    network_density: Math.round(networkDensity * 10000) / 10000,
    average_file_importance: Math.round(avgImportance * 100) / 100,
    most_important_file: mostImportant,
  };
}
















/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 THE MAIN EVENT - this is what you call from outside
 * Takes that Phase-1 map from scanner.js and adds ALL the juicy dependency analysis
 
 * This function mutates the map in place (cuz why copy when you can just,,, change it)
 
 @param {object} map - the Phase-1 map with files and stuff
 @returns {object} - the enriched map with links, cycles, networks, stats
 */
function mapDependencies(map) {
  // sanity check - make sure we got actual data
  if (!map || !Array.isArray(map.files)) {
    throw new Error('mapDependencies: input must be a Phase-1 map with a files array');
  }
  // if no packages array, make an empty one (dont crash pls)
  if (!Array.isArray(map.packages)) map.packages = [];

  // step 1: build lookup indexes for fast access
  const byPath = buildFileIndex(map.files);
  const packageIndex = buildPackageIndex(map.packages);
  const nextLinkId = makeIdGenerator();  // for giving each link a unique ID

  // step 2: find all the direct file-to-file and file-to-package links
  const { fileLinks, packageLinks } = buildDirectLinks(map, byPath, packageIndex, nextLinkId);

  // step 3: detect circular dependencies BEFORE computing indirect links
  // so we can mark circular links properly
  map.circular_dependencies = detectCircularDependencies(map, fileLinks);

  // step 4: find indirect connections (friends of friends)
  const indirectLinks = computeIndirectLinks(fileLinks, nextLinkId);

  // step 5: combine all links into the map
  map.links = [...fileLinks, ...indirectLinks, ...packageLinks];

  // step 6: calculate importance scores for each file
  computeImportance(map, fileLinks, packageLinks);

  // step 7: find network clusters (connected groups of files)
  map.networks = buildNetworks(map, fileLinks);

  // step 8: compute nerdy statistics
  map.statistics = computeStatistics(map, fileLinks, packageLinks);

  // tada! the map is now FULL of useful stuff
  return map;
}

module.exports = {
  mapDependencies,
  // Exported for tests / programmatic use:
  resolveFileImport,
  buildFileIndex,
  buildPackageIndex,
  findPackageForImport,
  betweennessCentrality,
  findSCCs,
  WEIGHTS,
};
