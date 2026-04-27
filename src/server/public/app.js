/* eslint-disable no-undef */
'use strict';

/**
RepoRose 3D visualization frontend

loads map.json from the server, renders a force-directed 3D graph
with search, physics controls, theme switching, details panel, etc

uses 3d-force-graph library (thats where most of the magic happens)
 */

// AND NO SHIT I WROTE THE WHOLE FILE MY SELF
// its like 1300 lines,,,,, I didnt even read this mahimoth
// IN fact,, I had made a visualization folder,,,, the AI said that is just trash,, and made this server folder folder,,,,
// I just deleted the visualization folder :)















/* ================================================================== */
/* Constants                                                           */
/* ================================================================== */

const COLORS = {
  code: '#1f77e8',
  package: '#2ca02c',
  config: '#9467bd',
  docs: '#ff7f0e',
  media: '#ff7f0e',
  style: '#9467bd',
  database: '#9467bd',
  other: '#1f77e8',
  isolated: '#999999',
  function: '#5fa8ff',
};

const PHYSICS_DEFAULTS = { gravity: 0.5, bounce: 0.8, friction: 0.3, link: 0.6 };
const PHYSICS_PRESETS = {
  relaxed:  { gravity: 0.3, bounce: 0.4, friction: 0.6, link: 0.4 },
  standard: { ...PHYSICS_DEFAULTS },
  tight:    { gravity: 0.7, bounce: 0.95, friction: 0.15, link: 0.85 },
};

const IMPORTANCE_TIERS = [
  { min: 8.0, label: 'Critical' },
  { min: 5.0, label: 'High' },
  { min: 2.0, label: 'Medium' },
  { min: 0.0, label: 'Low' },
];
















/* ================================================================== */
/* Global state                                                        */
/* ================================================================== */

const state = {
  map: null,
  graph: null,
  fullData: { nodes: [], links: [] },
  networkId: 'all',
  networks: [],
  networkChosen: false,
  highlightSet: new Set(),
  selectedId: null,
  options: {
    showLabels: true,
    showArrows: false,
    autoPause: true,
    limitEdges: false,
    controls: 'orbit',
  },
  physics: { ...PHYSICS_DEFAULTS },
  keysHeld: new Set(),
  fps: 0,
  fpsCounter: { frames: 0, last: performance.now() },
};
















/* ================================================================== */
/* Utility helpers                                                     */
/* ================================================================== */

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

function tierFor(score) {
  for (const t of IMPORTANCE_TIERS) if (score >= t.min) return t.label;
  return 'Low';
}

function nodeColor(n) {
  if (n.kind === 'package') return COLORS.package;
  if (n.kind === 'function') return COLORS.function;
  if (n.kind !== 'file') return COLORS.other;
  if (n.isolated) return COLORS.isolated;
  return COLORS[n.type] || COLORS.code;
}

function nodeSize(n) {
  if (n.kind === 'package') return 7 + Math.log(1 + (n.usage_count || 1)) * 3.5;
  if (n.kind === 'function') return 3;
  const score = n.importance_score || 0;
  return 3.5 + Math.pow(score + 1, 1.45) * 2.2;
}

function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
















/* ================================================================== */
/* Data shaping                                                        */
/* ================================================================== */

function buildGraphData(map) {
  const nodes = [];
  const seen = new Set();

  // Build set of file ids that are part of the main network.
  const mainNetwork = (map.networks || []).find((n) => n.id === 'network_main');
  const mainSet = new Set(mainNetwork ? mainNetwork.files : []);
  const isolatedNetwork = (map.networks || []).find((n) => n.id === 'network_isolated');
  const isolatedSet = new Set(isolatedNetwork ? isolatedNetwork.files : []);

  const fileCount = (map.files || []).length;
  const fileRadius = Math.max(160, Math.cbrt(Math.max(1, fileCount)) * 55);

  for (let i = 0; i < (map.files || []).length; i++) {
    const f = map.files[i];
    const pos = spherePoint(i, fileCount, fileRadius);
    nodes.push({
      id: f.id,
      kind: 'file',
      name: f.name,
      path: f.path,
      type: f.type,
      language: f.language,
      importance_score: f.importance_score || 0,
      description: f.description || '',
      size_bytes: f.size_bytes || 0,
      incoming: f.incoming_connections || 0,
      outgoing: f.outgoing_connections || 0,
      isolated: isolatedSet.has(f.id),
      inMain: mainSet.has(f.id),
      x: pos.x,
      y: pos.y,
      z: pos.z,
    });
    seen.add(f.id);
  }
  const packageRadius = fileRadius * 1.18;
  for (let i = 0; i < (map.packages || []).length; i++) {
    const p = map.packages[i];
    const pos = spherePoint(i, Math.max(1, (map.packages || []).length), packageRadius);
    nodes.push({
      id: p.id,
      kind: 'package',
      name: p.name,
      version: p.version,
      type: p.type,
      usage_count: p.usage_count || 0,
      importance_score: 0,
      description: `${p.type || 'dependency'} package${p.version ? ' v' + p.version : ''}`,
      x: pos.x,
      y: pos.y,
      z: pos.z,
    });
    seen.add(p.id);
  }

  const links = [];
  for (const l of map.links || []) {
    if (l.type === 'indirect') continue; // visual clarity — skip 2-hop synthetic links
    const src = l.from_file_id;
    const tgt = l.to_file_id || l.to_package_id;
    if (!src || !tgt || !seen.has(src) || !seen.has(tgt)) continue;
    links.push({
      source: src,
      target: tgt,
      type: l.type,
      weight: l.weight || 1,
      frequency: l.frequency || 1,
      is_circular: !!l.is_circular,
    });
  }

  return { nodes, links };
}

function applyFilter(data, filter) {
  if (filter === 'all') return data;
  const wantMain = filter === 'main';
  const keepNode = (n) => {
    if (n.kind === 'package') return wantMain;        // packages live with the main net
    return wantMain ? n.inMain : n.isolated;
  };
  const nodes = data.nodes.filter(keepNode);
  const ids = new Set(nodes.map((n) => n.id));
  const links = data.links.filter((l) => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return ids.has(s) && ids.has(t);
  });
  return { nodes, links };
}

function applyNetwork(data, networkId) {
  if (!networkId || networkId === 'all') return data;
  const network = state.networks.find((n) => n.id === networkId);
  if (!network) return data;
  const ids = new Set(network.nodeIds);
  const nodes = data.nodes.filter((n) => ids.has(n.id));
  const links = data.links.filter((l) => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return ids.has(s) && ids.has(t);
  });
  return { nodes, links };
}

function buildNetworks(data) {
  const adjacency = new Map();
  for (const n of data.nodes) adjacency.set(n.id, new Set());
  for (const l of data.links) {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (!adjacency.has(s) || !adjacency.has(t)) continue;
    adjacency.get(s).add(t);
    adjacency.get(t).add(s);
  }

  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const networks = [];
  for (const n of data.nodes) {
    if (seen.has(n.id)) continue;
    const stack = [n.id];
    const nodeIds = [];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop();
      nodeIds.push(id);
      for (const next of adjacency.get(id) || []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    const componentIds = new Set(nodeIds);
    const fileCount = nodeIds.filter((id) => byId.get(id) && byId.get(id).kind === 'file').length;
    const packageCount = nodeIds.filter((id) => byId.get(id) && byId.get(id).kind === 'package').length;
    const linkCount = data.links.filter((l) => {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      return componentIds.has(s) && componentIds.has(t);
    }).length;
    networks.push({ id: `network_${networks.length + 1}`, nodeIds, fileCount, packageCount, linkCount });
  }
  networks.sort((a, b) => b.nodeIds.length - a.nodeIds.length);
  networks.forEach((n, i) => {
    n.id = `network_${i + 1}`;
    n.label = i === 0 ? `Main network (${n.fileCount} files)` : `Network ${i + 1} (${n.fileCount} files)`;
  });
  return networks;
}

function populateNetworkSelect() {
  const select = $('#network-select');
  select.innerHTML = '<option value="all">All networks</option>';
  for (const network of state.networks) {
    const opt = document.createElement('option');
    opt.value = network.id;
    opt.textContent = network.label;
    select.appendChild(opt);
  }
  select.value = state.networkId;
  updateNetworkSummary();
}

function updateNetworkSummary() {
  const summary = $('#network-summary');
  if (state.networkId === 'all') {
    summary.textContent = `${state.networks.length} networks • ${state.fullData.nodes.length} nodes`;
    return;
  }
  const network = state.networks.find((n) => n.id === state.networkId);
  summary.textContent = network
    ? `${network.fileCount} files • ${network.packageCount} packages • ${network.linkCount} links`
    : '—';
}

function selectNetwork(networkId) {
  state.networkId = networkId || 'all';
  const select = $('#network-select');
  if (select) select.value = state.networkId;
  updateNetworkSummary();
  clearSelection();
  rebuildGraphData();
  scheduleFitGraph();
}

function stepNetwork(delta) {
  const ids = ['all', ...state.networks.map((n) => n.id)];
  const current = Math.max(0, ids.indexOf(state.networkId));
  const next = (current + delta + ids.length) % ids.length;
  selectNetwork(ids[next]);
}

function showNetworkPicker() {
  const picker = $('#network-picker');
  const list = $('#picker-list');
  if (!picker || !list) return;
  list.innerHTML = '';
  const totalFiles = state.fullData.nodes.filter((n) => n.kind === 'file').length;

  // If there is only one network, skip the picker entirely.
  if (state.networks.length <= 1) {
    pickNetwork(state.networks[0] ? state.networks[0].id : 'all');
    return;
  }

  for (let i = 0; i < state.networks.length; i++) {
    const net = state.networks[i];
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'picker-item';
    const isMain = i === 0;
    btn.innerHTML =
      `<span>` +
        `<div class="picker-title">${escapeHtml(net.label)}</div>` +
        `<div class="picker-meta">${net.fileCount} files · ${net.packageCount} packages · ${net.linkCount} links</div>` +
      `</span>` +
      (isMain ? `<span class="picker-badge">Recommended</span>` : '');
    btn.addEventListener('click', () => pickNetwork(net.id));
    li.appendChild(btn);
    list.appendChild(li);
  }

  const allBtn = $('#picker-all');
  if (allBtn) {
    allBtn.onclick = () => pickNetwork('all');
    allBtn.textContent = `Show all networks (${totalFiles} files)`;
  }
  picker.hidden = false;
}

function hideNetworkPicker() {
  const picker = $('#network-picker');
  if (picker) picker.hidden = true;
}

function pickNetwork(networkId) {
  state.networkChosen = true;
  hideNetworkPicker();
  selectNetwork(networkId);
  scheduleFitGraph();
}

function ensureNetworkChosen() {
  if (state.networkChosen) return;
  // Auto-pick main when the user interacts before picking (e.g., search).
  pickNetwork(state.networks[0] ? state.networks[0].id : 'all');
}

function applyEdgeLimit(data, limit) {
  if (!limit || data.links.length <= limit) return data;
  const sorted = [...data.links].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const top = sorted.slice(0, limit);
  return { nodes: data.nodes, links: top };
}

function spherePoint(i, total, radius) {
  if (total <= 1) return { x: 0, y: 0, z: 0 };
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (i / (total - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = golden * i;
  return {
    x: Math.cos(theta) * r * radius,
    y: y * radius,
    z: Math.sin(theta) * r * radius,
  };
}
















/* ================================================================== */
/* Graph init                                                          */
/* ================================================================== */

function isDark() {
  return document.documentElement.dataset.theme === 'dark';
}

function edgeColor() {
  return isDark() ? '#404040' : '#dadce0';
}

function initGraph() {
  if (typeof ForceGraph3D !== 'function') {
    showError('Failed to load 3D rendering library. Check your internet connection.');
    return;
  }
  const container = $('#canvas-container');
  // 3d-force-graph 1.80.x signature: `new ForceGraph3D(container, { controlType, ... })`.
  // The old `ForceGraph3D(config)(container)` curried form was removed.
  state.graph = new ForceGraph3D(container, { controlType: state.options.controls })
    .backgroundColor(isDark() ? '#0f0f0f' : '#ffffff')
    .nodeRelSize(4)
    .nodeColor(nodeColor)
    .nodeVal(nodeSize)
    .nodeOpacity(0.92)
    .nodeLabel((n) => `<strong>${escapeHtml(n.name)}</strong><div class="muted">${escapeHtml(n.path || n.kind || '')}</div>${n.importance_score ? `<div class="muted">Importance ${n.importance_score.toFixed(1)} (${tierFor(n.importance_score)})</div>` : ''}`)
    .linkOpacity(0.6)
    .linkColor(edgeColor)
    .linkWidth((l) => Math.min(2, Math.max(0.4, Math.log10(1 + (l.weight || 1)) * 0.7)))
    .linkDirectionalArrowLength((l) => state.options.showArrows ? 4 : 0)
    .linkDirectionalArrowRelPos(0.96)
    .linkDirectionalParticles((l) => l.is_circular ? 2 : 0)
    .linkDirectionalParticleColor(() => '#ff5566')
    .linkDirectionalParticleSpeed(0.005)
    .onNodeClick(handleNodeClick)
    .onBackgroundClick(() => clearSelection());

  state.graph.onEngineTick(onEngineTick);
  if (state.graph.onNodeRightClick) {
    state.graph.onNodeRightClick(handleNodeClick);
  }

  // custom tooltip that follows cursor
  container.addEventListener('mousemove', onPointerMove);
  state.graph.onNodeHover(handleNodeHover);
}

// recreate graph with different camera controls
function recreateGraphWithControls(newType) {
  state.options.controls = newType;
  const container = $('#canvas-container');
  if (state.graph && typeof state.graph._destructor === 'function') {
    state.graph._destructor();
  }
  container.innerHTML = '';
  initGraph();
  rebuildGraphData();
  scheduleFitGraph();
}

function fitGraph(duration = 800, padding = 80) {
  const g = state.graph;
  if (!g) return;

  const data = g.graphData ? g.graphData() : state.fullData;
  const nodes = (data && data.nodes) || [];
  if (!nodes.length) return;

  if (typeof g.zoomToFit === 'function') {
    g.zoomToFit(duration, padding, () => true);
  }

  const extent = nodes.reduce((max, n) => {
    const x = Number.isFinite(n.x) ? n.x : 0;
    const y = Number.isFinite(n.y) ? n.y : 0;
    const z = Number.isFinite(n.z) ? n.z : 0;
    return Math.max(max, Math.abs(x), Math.abs(y), Math.abs(z));
  }, 1);

  // fallback if zoomToFit cant compute bbox yet (happens during early layout)
  const dist = Math.max(600, extent * 3.2);
  if (typeof g.cameraPosition === 'function') {
    g.cameraPosition({ x: 0, y: 0, z: dist }, { x: 0, y: 0, z: 0 }, duration);
  }
}

function scheduleFitGraph() {
  [80, 350, 900, 1800, 3200].forEach((delay) => {
    setTimeout(() => fitGraph(700, 100), delay);
  });
}

function showError(msg) {
  $('#loading').hidden = true;
  const err = $('#error');
  $('#error-text').textContent = msg;
  err.hidden = false;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
















/* ================================================================== */
/* Render data + physics                                               */
/* ================================================================== */

function rebuildGraphData() {
  let data = applyNetwork(state.fullData, state.networkId);
  if (state.options.limitEdges) data = applyEdgeLimit(data, 100);
  state.graph.graphData(data);
  // defer physics to next tick — calling d3ReheatSimulation immediately
  // crashes cuz internal state hasnt been set yet. 0ms timeout fixes it.
  setTimeout(() => applyPhysics(), 0);
  updateStats(data);
}

function applyPhysics() {
  const g = state.graph;
  if (!g) return;

  // check if simulation is ready, skip if not (prevents crash)
  const charge = g.d3Force ? g.d3Force('charge') : null;
  if (!charge) return;

  const { gravity, bounce, friction, link } = state.physics;

  if (typeof charge.strength === 'function') {
    charge.strength(-30 - gravity * 250);
  }

  const linkForce = g.d3Force('link');
  if (linkForce && typeof linkForce.strength === 'function') {
    linkForce.strength((l) => link * (1 / Math.max(1, Math.min(8, (l.frequency || 1)))));
    if (typeof linkForce.distance === 'function') {
      linkForce.distance(60 + (1 - link) * 120);
    }
  }

  // blend friction and bounce into d3 velocity decay
  const decay = Math.max(0.05, Math.min(0.95, 0.2 + friction * 0.6 - bounce * 0.15));
  if (typeof g.d3VelocityDecay === 'function') g.d3VelocityDecay(decay);

  // Alpha controls how "alive" the simulation is — bouncier preset reheats it.
  if (typeof g.d3AlphaDecay === 'function') g.d3AlphaDecay(0.005 + (1 - bounce) * 0.04);
  if (typeof g.d3ReheatSimulation === 'function') g.d3ReheatSimulation();
}
















/* ================================================================== */
/* Selection / details panel                                           */
/* ================================================================== */

function clearSelection() {
  state.selectedId = null;
  state.highlightSet.clear();
  $('#details-panel').hidden = true;
  if (state.graph) {
    state.graph
      .nodeColor(nodeColor)
      .nodeOpacity(0.92)
      .linkOpacity(0.6);
  }
}

function highlightAround(id) {
  state.highlightSet = new Set([id]);
  for (const l of state.fullData.links) {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (s === id) state.highlightSet.add(t);
    if (t === id) state.highlightSet.add(s);
  }
}

function focusNode(node) {
  if (!node) return;
  state.selectedId = node.id;
  highlightAround(node.id);
  // camera fly-to animation
  const dist = 220;
  const ratio = node.x === 0 && node.y === 0 && node.z === 0 ? 0 : dist / Math.hypot(node.x || 1, node.y || 1, node.z || 1);
  state.graph.cameraPosition(
    { x: (node.x || 0) * ratio + dist, y: (node.y || 0) * ratio, z: (node.z || 0) * ratio },
    node,
    900,
  );
  // dim non-highlighted nodes/links
  state.graph
    .nodeOpacity(0.3)
    .linkOpacity(0.1);
  // re-apply colors selectively
  state.graph
    .nodeColor((n) => state.highlightSet.has(n.id) ? nodeColor(n) : addAlpha(nodeColor(n), 0.45));
  loadAndShowDetails(node.id);
}

function addAlpha(hex, alpha) {
  // Pass through — three.js material handles opacity per-material; we keep
  // colours hex and rely on nodeOpacity above. Returning original is fine.
  return hex;
}

async function loadAndShowDetails(id) {
  try {
    const res = await fetch(`/api/node/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error('not found');
    const detail = await res.json();
    renderDetails(detail);
  } catch (e) {
    // Fall back to in-memory record
    const fromMap =
      (state.map.files || []).find((f) => f.id === id) ||
      (state.map.packages || []).find((p) => p.id === id);
    if (fromMap) renderDetails({ kind: fromMap.path ? 'file' : 'package', ...fromMap });
  }
}

function renderDetails(detail) {
  const panel = $('#details-panel');
  panel.hidden = false;
  $('#settings-menu').hidden = true;

  $('#detail-name').textContent = detail.name || '—';
  $('#detail-path').textContent = detail.path || detail.name || '—';
  $('#detail-language').textContent = detail.language ? `${detail.language} • ${detail.kind || ''}` : (detail.kind || '');
  if (detail.kind === 'package') {
    $('#detail-importance').textContent = '—';
    $('#detail-importance-tier').textContent = `${detail.usage_count || 0} importers`;
    $('#detail-incoming').textContent = detail.usage_count || 0;
    $('#detail-outgoing').textContent = '—';
    $('#detail-size').textContent = detail.version || '—';
  } else {
    const score = detail.importance_score || 0;
    $('#detail-importance').textContent = score.toFixed(1);
    $('#detail-importance-tier').textContent = `(${tierFor(score)})`;
    $('#detail-incoming').textContent = detail.incoming_connections || (detail.connections && detail.connections.incoming.length) || 0;
    $('#detail-outgoing').textContent = detail.outgoing_connections || (detail.connections && detail.connections.outgoing.length) || 0;
    $('#detail-size').textContent = fmtBytes(detail.size_bytes);
  }
  $('#detail-description').textContent = detail.description || '(no description available)';

  // Lists
  const importsList = $('#detail-imports');
  const incomingList = $('#detail-incoming-list');
  const packagesList = $('#detail-packages');
  const fnsList = $('#detail-functions');
  importsList.innerHTML = '';
  incomingList.innerHTML = '';
  packagesList.innerHTML = '';
  fnsList.innerHTML = '';

  const conn = detail.connections || { incoming: [], outgoing: [], packages_used: [] };
  fillList(importsList, conn.outgoing, (c) => focusById(c.file_id));
  fillList(incomingList, conn.incoming, (c) => focusById(c.file_id));
  fillList(
    packagesList,
    conn.packages_used.map((p) => ({ name: p.name, path: p.version ? `v${p.version}` : '' })),
    null,
  );
  fillList(
    fnsList,
    (detail.functions || []).map((f) => ({
      name: f.name,
      path: f.signature || f.type,
    })),
    null,
  );
}

function fillList(ul, items, onClick) {
  if (!items || items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '— none —';
    ul.appendChild(li);
    return;
  }
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(it.name || '?')}</span><span class="arrow">${escapeHtml(it.path || '')} →</span>`;
    if (onClick) li.addEventListener('click', () => onClick(it));
    else li.style.cursor = 'default';
    ul.appendChild(li);
  }
}

function focusById(id) {
  if (!state.graph) return;
  ensureNetworkChosen();
  let node = state.graph.graphData().nodes.find((n) => n.id === id);
  if (node) {
    focusNode(node);
    return;
  }
  const network = state.networks.find((n) => n.nodeIds.includes(id));
  if (network && state.networkId !== 'all' && state.networkId !== network.id) {
    selectNetwork(network.id);
    setTimeout(() => {
      node = state.graph.graphData().nodes.find((n) => n.id === id);
      if (node) focusNode(node);
    }, 80);
    return;
  }
  node = state.fullData.nodes.find((n) => n.id === id);
  if (node) {
    selectNetwork('all');
    setTimeout(() => {
      const visible = state.graph.graphData().nodes.find((n) => n.id === id);
      if (visible) focusNode(visible);
    }, 80);
  }
}

function handleNodeClick(node) {
  focusNode(node);
}
















/* ================================================================== */
/* Tooltip                                                             */
/* ================================================================== */

function handleNodeHover(node) {
  const tip = $('#tooltip');
  if (!node) {
    tip.hidden = true;
    document.body.style.cursor = '';
    return;
  }
  document.body.style.cursor = 'pointer';
  const score = node.importance_score || 0;
  tip.innerHTML =
    `<strong>${escapeHtml(node.name)}</strong>` +
    `<div class="muted">${escapeHtml(node.path || node.kind)}</div>` +
    (node.kind === 'file'
      ? `<div class="muted">Importance ${score.toFixed(1)} (${tierFor(score)})</div>`
      : (node.kind === 'package' ? `<div class="muted">${node.usage_count || 0} importers</div>` : ''));
  tip.hidden = false;
}

function onPointerMove(e) {
  const tip = $('#tooltip');
  if (tip.hidden) return;
  const x = e.clientX + 14;
  const y = e.clientY + 14;
  tip.style.left = `${Math.min(x, window.innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${Math.min(y, window.innerHeight - tip.offsetHeight - 8)}px`;
}
















/* ================================================================== */
/* Search                                                              */
/* ================================================================== */

const runSearch = debounce(async (q) => {
  if (!q || !q.trim()) {
    $('#search-results').hidden = true;
    $('#search-results').innerHTML = '';
    return;
  }
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=10`);
    const data = await res.json();
    renderSearchResults(data.results || []);
  } catch (e) {
    // ignore
  }
}, 120);

function renderSearchResults(results) {
  const container = $('#search-results');
  container.innerHTML = '';
  if (!results.length) {
    container.hidden = true;
    return;
  }
  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'search-result';
    div.innerHTML =
      `<div class="row1">` +
        `<span class="kind ${r.kind}">${r.kind}</span>` +
        `<span class="name">${escapeHtml(r.name)}</span>` +
        `<span class="importance">${(r.importance || 0).toFixed(1)}</span>` +
      `</div>` +
      `<div class="desc">${escapeHtml(r.description || r.path || '')}</div>`;
    div.addEventListener('click', () => {
      $('#search-results').hidden = true;
      $('#search-input').value = r.name;
      const id = r.kind === 'function' ? r.file_id : r.id;
      focusById(id);
    });
    container.appendChild(div);
  }
  container.hidden = false;
}
















/* ================================================================== */
/* Camera helpers (Space/Shift up/down)                                */
/* ================================================================== */

function nudgeCameraVertical(dir) {
  if (!state.graph) return;
  const cam = state.graph.camera();
  if (!cam) return;
  const speed = 6;
  cam.position.y += dir * speed;
}
















/* ================================================================== */
/* Theme                                                               */
/* ================================================================== */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').textContent = theme === 'dark' ? '🌙' : '☀️';
  if (state.graph) {
    state.graph.backgroundColor(theme === 'dark' ? '#0f0f0f' : '#ffffff');
    state.graph.linkColor(edgeColor);
  }
  try { localStorage.setItem('reporose-theme', theme); } catch (_e) {}
}

function toggleTheme() {
  applyTheme(isDark() ? 'light' : 'dark');
}
















/* ================================================================== */
/* Stats / FPS                                                         */
/* ================================================================== */

function updateStats(data) {
  $('#stat-files').textContent = (data || state.fullData).nodes.length;
  $('#stat-links').textContent = (data || state.fullData).links.length;
}

function onEngineTick() {
  state.fpsCounter.frames += 1;
  const now = performance.now();
  const elapsed = now - state.fpsCounter.last;
  if (elapsed > 500) {
    state.fps = Math.round((state.fpsCounter.frames * 1000) / elapsed);
    $('#stat-fps').textContent = state.fps;
    state.fpsCounter.frames = 0;
    state.fpsCounter.last = now;
  }
}
















/* ================================================================== */
/* Wiring                                                              */
/* ================================================================== */

function bindUI() {
  // Theme
  $('#theme-toggle').addEventListener('click', toggleTheme);

  // Logo resets view
  $('#logo-btn').addEventListener('click', () => {
    clearSelection();
    fitGraph(800, 80);
  });
  $('#fit-btn').addEventListener('click', () => fitGraph(800, 80));

  // Search
  const input = $('#search-input');
  input.addEventListener('input', (e) => runSearch(e.target.value));
  input.addEventListener('focus', () => {
    if (input.value.trim()) runSearch(input.value);
  });
  document.addEventListener('click', (e) => {
    if (!$('#search-bar').contains(e.target)) $('#search-results').hidden = true;
  });

  // Physics sliders
  bindSlider('#gravity-slider', '#gravity-value', 'gravity');
  bindSlider('#bounce-slider', '#bounce-value', 'bounce');
  bindSlider('#friction-slider', '#friction-value', 'friction');
  bindSlider('#link-slider', '#link-value', 'link');

  $('#reset-physics').addEventListener('click', () => {
    setPhysics(PHYSICS_DEFAULTS);
  });

  // Network selector
  $('#network-select').addEventListener('change', (e) => selectNetwork(e.target.value));
  $('#network-prev').addEventListener('click', () => stepNetwork(-1));
  $('#network-next').addEventListener('click', () => stepNetwork(1));
  const pickerBtn = $('#network-picker-btn');
  if (pickerBtn) pickerBtn.addEventListener('click', () => showNetworkPicker());

  // Settings
  $('#settings-btn').addEventListener('click', () => {
    const m = $('#settings-menu');
    m.hidden = !m.hidden;
    if (!m.hidden) {
      $('#details-panel').hidden = true;
      $('#help-panel').hidden = true;
    }
  });
  $('#settings-close').addEventListener('click', () => { $('#settings-menu').hidden = true; });

  $('#opt-labels').addEventListener('change', (e) => { state.options.showLabels = e.target.checked; applyLabelOption(); });
  $('#opt-arrows').addEventListener('change', (e) => { state.options.showArrows = e.target.checked; rebuildGraphData(); });
  $('#opt-pause').addEventListener('change', (e) => { state.options.autoPause = e.target.checked; });
  $('#opt-limit').addEventListener('change', (e) => { state.options.limitEdges = e.target.checked; rebuildGraphData(); });
  $('#opt-preset').addEventListener('change', (e) => { setPhysics(PHYSICS_PRESETS[e.target.value] || PHYSICS_DEFAULTS); });
  $('#opt-controls').addEventListener('change', (e) => {
    recreateGraphWithControls(e.target.value);
  });

  $('#export-json').addEventListener('click', exportJson);
  $('#export-png').addEventListener('click', exportPng);

  // Details panel
  $('#details-close').addEventListener('click', clearSelection);

  // Help
  $('#help-close').addEventListener('click', () => { $('#help-panel').hidden = true; });

  // Physics panel collapse
  $('#physics-collapse').addEventListener('click', () => {
    $('#physics-panel').classList.toggle('collapsed');
  });

  // Keyboard
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  // Tick custom keyboard movement
  setInterval(applyKeyboardMovement, 30);

  // Resize
  window.addEventListener('resize', () => {
    if (state.graph) {
      state.graph.width(window.innerWidth);
      state.graph.height(window.innerHeight);
    }
  });
}

function bindSlider(selSlider, selValue, key) {
  const slider = $(selSlider);
  const value = $(selValue);
  slider.addEventListener('input', () => {
    state.physics[key] = Number(slider.value);
    value.textContent = Number(slider.value).toFixed(2);
    applyPhysics();
  });
}

function setPhysics(next) {
  state.physics = { ...next };
  $('#gravity-slider').value = next.gravity; $('#gravity-value').textContent = next.gravity.toFixed(2);
  $('#bounce-slider').value = next.bounce;   $('#bounce-value').textContent = next.bounce.toFixed(2);
  $('#friction-slider').value = next.friction; $('#friction-value').textContent = next.friction.toFixed(2);
  $('#link-slider').value = next.link;       $('#link-value').textContent = next.link.toFixed(2);
  applyPhysics();
}

function applyLabelOption() {
  if (!state.graph) return;
  // Toggling node label simply hides hover label. (3d-force-graph nodeLabel
  // only shows on hover by default, so this also affects tooltip vs. THREE
  // sprite labels.) Keep behaviour simple — pass empty string when off.
  if (state.options.showLabels) {
    state.graph.nodeLabel((n) => `<strong>${escapeHtml(n.name)}</strong><div class="muted">${escapeHtml(n.path || n.kind || '')}</div>`);
  } else {
    state.graph.nodeLabel(() => '');
  }
}
















/* ================================================================== */
/* Keyboard                                                            */
/* ================================================================== */

function onKeyDown(e) {
  // ctrl/cmd + k focuses search
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#search-input').focus();
    $('#search-input').select();
    return;
  }
  if (e.key === 'Escape') {
    const picker = $('#network-picker');
    if (picker && !picker.hidden) {
      ensureNetworkChosen();
      return;
    }
    clearSelection();
    $('#settings-menu').hidden = true;
    $('#help-panel').hidden = true;
    $('#search-results').hidden = true;
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    return;
  }
  if (e.key === '?' && document.activeElement.tagName !== 'INPUT') {
    $('#help-panel').hidden = !$('#help-panel').hidden;
    return;
  }
  // skip if typing in an input
  if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

  state.keysHeld.add(e.key.toLowerCase());

  if (e.key === ' ') {
    e.preventDefault();
    nudgeCameraVertical(1);
  } else if (e.key === 'Shift') {
    nudgeCameraVertical(-1);
  }
}

function onKeyUp(e) {
  state.keysHeld.delete(e.key.toLowerCase());
}

function applyKeyboardMovement() {
  if (!state.graph) return;
  // hold-to-repeat for space/shift only (WASD is handled by FlyControls)
  if (state.keysHeld.has(' ')) nudgeCameraVertical(1);
  if (state.keysHeld.has('shift')) nudgeCameraVertical(-1);
}
















/* ================================================================== */
/* Export                                                              */
/* ================================================================== */

function exportJson() {
  const blob = new Blob([JSON.stringify(state.map, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'reporose-map.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportPng() {
  if (!state.graph) return;
  const renderer = state.graph.renderer && state.graph.renderer();
  const scene = state.graph.scene && state.graph.scene();
  const cam = state.graph.camera && state.graph.camera();
  if (!renderer || !scene || !cam) return;
  renderer.render(scene, cam);
  const dataUrl = renderer.domElement.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = dataUrl; a.download = 'reporose.png';
  document.body.appendChild(a); a.click(); a.remove();
}
















/* ================================================================== */
/* Boot                                                                */
/* ================================================================== */

async function boot() {
  // restore saved theme or use system preference
  let saved = null;
  try { saved = localStorage.getItem('reporose-theme'); } catch (_e) {}
  applyTheme(saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  bindUI();

  try {
    const res = await fetch('/api/graph');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.map = await res.json();
  } catch (err) {
    showError(`Failed to load map: ${err.message}. Run \`reporose analyze\` and refresh.`);
    return;
  }

  state.fullData = buildGraphData(state.map);
  state.networks = buildNetworks(state.fullData);
  populateNetworkSelect();
  initGraph();
  if (!state.graph) return;
  // start with empty graph so the user can pick a network first
  state.graph.graphData({ nodes: [], links: [] });
  updateStats(state.fullData);

  setTimeout(() => { $('#loading').hidden = true; }, 250);
  showNetworkPicker();
}

document.addEventListener('DOMContentLoaded', boot);
