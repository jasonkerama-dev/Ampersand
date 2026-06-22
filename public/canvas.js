(function () {

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');

  const selRing = document.getElementById('selectionRing');
  const rNW = document.getElementById('resizeNW');
  const rNE = document.getElementById('resizeNE');
  const rSW = document.getElementById('resizeSW');
  const rSE = document.getElementById('resizeSE');

  const BASE_GRID_SIZE = 40;
  const DOT_RADIUS = 2.5;
  const PORT_RADIUS = 4;
  const PORT_HOVER_RADIUS = 20;
  const SNAP_RADIUS = 20;

  let keysDown = {};
  let animFrame = null;
  const MAX_SPEED = 16;
  const ACCEL = 0.6;
  const FRICTION = 0.88;
  let velX = 0, velY = 0;

  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let viewStart = { x: 0, y: 0 };
  let isDraggingNode = false;
  let dragOffset = { x: 0, y: 0 };
  let groupDragOffsets = null;
  let isResizing = false;
  let resizeCorner = '';
  let resizeStart = { x: 0, y: 0 };
  let nodeStartProps = {};
  let isDraggingPort = false;
  let draggingPort = null;
  let dragPortWorld = { x: 0, y: 0 };
  let snapTarget = null;

  let nodeIdCounter = 0;
  let pendingVarPos = null;
  let editingVar = null;
  let pendingImmPos = null;
  let editingImm = null;
  let fnNode = null;

  let projectSettings = { memory: 8192, immutable_pct: 3, max_cycles: 1000 };

  let nodes = [];
  let edges = [];
  let view = { x: 0, y: 0, zoom: 1 };
  let selectedNode = null;
  let selectedEdge = null;
  let selectedNodes = [];
  let multiSelectActive = false;
  let isBoxSelecting = false;
  let boxSelectStart = { x: 0, y: 0 };
  let boxSelectRect = null;

  /* ---- Undo / Redo ---- */
  let undoStack = [];
  let redoStack = [];
  const MAX_UNDO = 50;

  function pushUndo() {
    if (undoStack.length >= MAX_UNDO) undoStack.shift();
    redoStack = [];
    undoStack.push({
      nodes: nodes.map(n => JSON.parse(JSON.stringify(n))),
      edges: edges.map(e => ({ ...e })),
    });
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push({
      nodes: nodes.map(n => JSON.parse(JSON.stringify(n))),
      edges: edges.map(e => ({ ...e })),
    });
    const state = undoStack.pop();
    restoreState(state);
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push({
      nodes: nodes.map(n => JSON.parse(JSON.stringify(n))),
      edges: edges.map(e => ({ ...e })),
    });
    const state = redoStack.pop();
    restoreState(state);
  }

  function restoreState(state) {
    nodes.length = 0;
    edges.length = 0;
    for (const n of state.nodes) nodes.push(n);
    for (const e of state.edges) edges.push(e);
    selectedNode = null;
    selectedNodes = [];
    selectedEdge = null;
    fnNode = null;
    deselectNode();
    render();
  }

  let sizeInKB = 1;
  let autoCompleteActive = false;
  let autoCompleteResults = [];
  let autoCompleteIdx = 0;
  let autoCompleteTriggerPos = 0;
  let autoCompleteField = null;

  /* ---- Tab system ---- */
  let programName = 'Unsaved';
  let isDirty = false;
  let projectDropdownOpen = false;
  let mouseScreen = null;
  let mouseWorld = null;

  let tabs = [];
  let activeTabIdx = -1;

  const tabListEl = document.getElementById('tabList');

  function currentTab() { return tabs[activeTabIdx] || null; }

  function snapshotTab() {
    const t = currentTab();
    if (!t) return;
    t.nodes = nodes;
    t.edges = edges.slice();
    t.view = { x: view.x, y: view.y, zoom: view.zoom };
    t.isDirty = isDirty;
    t.programName = programName;
    t.undoStack = undoStack;
    t.redoStack = redoStack;
  }

  function switchTab(idx) {
    if (idx === activeTabIdx || idx < 0 || idx >= tabs.length) return;
    snapshotTab();
    activeTabIdx = idx;
    const t = tabs[idx];
    nodes = t.nodes;
    edges = t.edges;
    view = { x: t.view.x, y: t.view.y, zoom: t.view.zoom };
    isDirty = t.isDirty;
    programName = t.programName;
    undoStack = t.undoStack || [];
    redoStack = t.redoStack || [];
    progDisplay.textContent = programName;
    if (isDirty) progDisplay.classList.add('dirty');
    else progDisplay.classList.remove('dirty');
    deselectNode();
    renderTabBar();
    render();
  }

  function makeTabState(name, nodesArr, edgesArr) {
    return {
      name,
      nodes: nodesArr,
      edges: edgesArr,
      view: { x: 0, y: 0, zoom: 1 },
      isDirty: false,
      programName: name,
      undoStack: [],
      redoStack: [],
    };
  }

  function addTab(name, adgText) {
    snapshotTab();
    if (adgText) {
      const savedNodes = [];
      const savedEdges = [];
      const savedView = { x: 0, y: 0, zoom: 1 };
      const heldNodes = nodes; const heldEdges = edges;
      nodes = savedNodes; edges = savedEdges;
      parseAdgToCanvasInner(adgText, savedNodes, savedEdges);
      nodes = heldNodes; edges = heldEdges;
      tabs.push(makeTabState(name, savedNodes, savedEdges));
    } else {
      tabs.push(makeTabState(name, [], []));
    }
    activeTabIdx = tabs.length - 1;
    const t = tabs[activeTabIdx];
    nodes = t.nodes;
    edges = t.edges;
    view = { x: t.view.x, y: t.view.y, zoom: t.view.zoom };
    undoStack = t.undoStack || [];
    redoStack = t.redoStack || [];
    isDirty = false;
    programName = name;
    progDisplay.textContent = name;
    progDisplay.classList.remove('dirty');
    deselectNode();
    renderTabBar();
    render();
  }

  function closeTab(idx) {
    if (tabs.length <= 1) return;
    if (idx === activeTabIdx) {
      snapshotTab();
      const next = idx > 0 ? idx - 1 : 1;
      tabs.splice(idx, 1);
      activeTabIdx = Math.min(next, tabs.length - 1);
      const t = tabs[activeTabIdx];
      nodes = t.nodes;
      edges = t.edges;
      view = { x: t.view.x, y: t.view.y, zoom: t.view.zoom };
      isDirty = t.isDirty;
      programName = t.programName;
      undoStack = t.undoStack || [];
      redoStack = t.redoStack || [];
      progDisplay.textContent = programName;
      if (isDirty) progDisplay.classList.add('dirty');
      else progDisplay.classList.remove('dirty');
      deselectNode();
    } else {
      tabs.splice(idx, 1);
      if (idx < activeTabIdx) activeTabIdx--;
    }
    renderTabBar();
    render();
  }

  function renderTabBar() {
    tabListEl.innerHTML = '';
    tabs.forEach((t, i) => {
      const item = document.createElement('div');
      item.className = 'tab-item' + (i === activeTabIdx ? ' active' : '') + (t.isDirty ? ' dirty' : '');
      const dot = document.createElement('span');
      dot.className = 'tab-dirty';
      item.appendChild(dot);
      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = t.name;
      item.appendChild(name);
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      close.addEventListener('mousedown', (e) => { e.stopPropagation(); closeTab(i); });
      item.appendChild(close);
      item.addEventListener('mousedown', (e) => { if (e.button === 0) switchTab(i); });
      tabListEl.appendChild(item);
    });
  }

  function markDirty() {
    if (!isDirty) {
      isDirty = true;
      progDisplay.classList.add('dirty');
      const t = currentTab();
      if (t) { t.isDirty = true; renderTabBar(); }
    }
  }

  const searchInput = document.getElementById('searchInput');
  const fnEditor = document.getElementById('fnEditor');
  const inputsField = document.getElementById('inputsField');
  const fnNameInput = document.getElementById('fnNameInput');
  const sizeInput = document.getElementById('sizeValue');
  const sizeUnit = document.getElementById('sizeUnit');
  const sizeBarFill = document.getElementById('sizeBarFill');
  const outputBox = document.getElementById('outputBox');
  const progDisplay = document.getElementById('programNameDisplay');
  const saveIndicator = document.getElementById('saveIndicator');

  const App = {
    canvas, ctx, nodes, edges, view, selectedNode,
    fnEditor, inputsField, fnNameInput, outputBox,
    progDisplay, saveIndicator,
    get fnNode() { return fnNode; },
    set fnNode(v) { fnNode = v; },
    get sizeInKB() { return sizeInKB; },
    set sizeInKB(v) { sizeInKB = v; },
    get isDirty() { return isDirty; },
    set isDirty(v) { isDirty = v; },
    get programName() { return programName; },
    set programName(v) { programName = v; },
    get projectDropdownOpen() { return projectDropdownOpen; },
    set projectDropdownOpen(v) { projectDropdownOpen = v; },
  };
  window.App = App;

  let resizeFrame = null;
  function resizeCanvas() {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      if (!document.querySelector('.modal-overlay[style*="flex"]')) render();
    });
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function measureText(text, fontSize) {
    const tmp = document.createElement('canvas').getContext('2d');
    tmp.font = `${fontSize}px 'Inter', system-ui, sans-serif`;
    return tmp.measureText(text).width;
  }

  function fitNodeWidth(n, text, minWidth, pad) {
    if (!text) return;
    const mw = measureText(text, n.type === 'function' ? 14 : 13);
    n.w = Math.max(minWidth, (mw + pad) / (view.zoom || 1));
  }

  function screenToWorld(sx, sy) {
    return { x: (sx - canvas.width / 2) / view.zoom - view.x, y: (sy - canvas.height / 2) / view.zoom - view.y };
  }

  function worldToScreen(wx, wy) {
    return {
      x: Math.round((wx + view.x) * view.zoom + canvas.width / 2),
      y: Math.round((wy + view.y) * view.zoom + canvas.height / 2)
    };
  }

  /* ---- Movement ---- */

  function updateMovement() {
    let dx = 0, dy = 0;
    if (keysDown['ArrowLeft'] || keysDown['KeyA'] || keysDown['a']) dx = -1;
    if (keysDown['ArrowRight'] || keysDown['KeyD'] || keysDown['d']) dx = 1;
    if (keysDown['ArrowUp'] || keysDown['KeyW'] || keysDown['w']) dy = -1;
    if (keysDown['ArrowDown'] || keysDown['KeyS'] || keysDown['s']) dy = 1;
    if (dx !== 0 || dy !== 0) {
      const len = Math.sqrt(dx * dx + dy * dy);
      dx /= len; dy /= len;
      velX += dx * ACCEL; velY += dy * ACCEL;
      if (Math.abs(velX) > MAX_SPEED) velX = Math.sign(velX) * MAX_SPEED;
      if (Math.abs(velY) > MAX_SPEED) velY = Math.sign(velY) * MAX_SPEED;
    } else {
      velX *= FRICTION; velY *= FRICTION;
      if (Math.abs(velX) < 0.1) velX = 0;
      if (Math.abs(velY) < 0.1) velY = 0;
    }
    if (velX !== 0 || velY !== 0) {
      view.x -= velX / view.zoom;
      view.y -= velY / view.zoom;
      render();
    }
    animFrame = requestAnimationFrame(updateMovement);
  }

  function startMovementLoop() {
    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = requestAnimationFrame(updateMovement);
  }

  /* ---- Grid ---- */

  function drawGrid() {
    const gridStep = BASE_GRID_SIZE * view.zoom;
    if (gridStep < 6) return;
    const left = -view.x - canvas.width / (2 * view.zoom);
    const top = -view.y - canvas.height / (2 * view.zoom);
    const right = left + canvas.width / view.zoom;
    const bottom = top + canvas.height / view.zoom;
    const startX = Math.floor(left / BASE_GRID_SIZE) * BASE_GRID_SIZE;
    const startY = Math.floor(top / BASE_GRID_SIZE) * BASE_GRID_SIZE;
    const r = Math.max(1, DOT_RADIUS);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    for (let x = startX; x <= right; x += BASE_GRID_SIZE) {
      for (let y = startY; y <= bottom; y += BASE_GRID_SIZE) {
        const sx = Math.round((x + view.x) * view.zoom + canvas.width / 2);
        const sy = Math.round((y + view.y) * view.zoom + canvas.height / 2);
        ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      }
    }
    const ox = Math.round(view.x * view.zoom + canvas.width / 2);
    const oy = Math.round(view.y * view.zoom + canvas.height / 2);
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ox - 20, oy); ctx.lineTo(ox + 20, oy);
    ctx.moveTo(ox, oy - 20); ctx.lineTo(ox, oy + 20);
    ctx.stroke();
  }

  /* ---- Ports (dynamic multi-side routing) ---- */
  //
  // Immutable port rules:
  //   - UNINITIALIZED immutable: one output port (right side) AND one input port
  //     (left side) -- the two ports sit on opposite sides of the node, so a
  //     value can be streamed IN on the left while still being able to wire OUT
  //     on the right.
  //   - INITIALIZED immutable (already holds a value): output port only, on the
  //     right. No input port is exposed, since a WORM immutable can't be
  //     written to again.

  function getPorts(node) {
    const ports = [];
    const hc = { x: node.x + node.w / 2, y: node.y + node.h / 2 };
    const inset = 6;

    if (node.type === 'immutable') {
      ports.push({ id: 'out', label: '', node, type: 'output', wx: node.x + node.w, wy: hc.y });
      if (!node.initialized) {
        ports.push({ id: 'in', label: '', node, type: 'input', wx: node.x, wy: hc.y });
      }
    } else if (node.type === 'variable') {
      ports.push({ id: 'out',  label: '', node, type: 'output', wx: node.x + node.w, wy: hc.y });
      ports.push({ id: 'out_left', label: '', node, type: 'output', wx: node.x, wy: hc.y });
      ports.push({ id: 'out_top', label: '', node, type: 'output', wx: hc.x, wy: node.y });
      ports.push({ id: 'out_bottom', label: '', node, type: 'output', wx: hc.x, wy: node.y + node.h });
      ports.push({ id: 'in',  label: '', node, type: 'input', wx: node.x + node.w - inset, wy: hc.y });
      ports.push({ id: 'in_left', label: '', node, type: 'input', wx: node.x + inset, wy: hc.y });
      ports.push({ id: 'in_top', label: '', node, type: 'input', wx: hc.x, wy: node.y + inset });
      ports.push({ id: 'in_bottom', label: '', node, type: 'input', wx: hc.x, wy: node.y + node.h - inset });
    } else if (node.type === 'function') {
      const inputs = node.fnInputs ? node.fnInputs.split(',').map(s => s.trim()).filter(Boolean) : [];
      if (inputs.length > 0) {
        inputs.forEach((name, i) => {
          ports.push({ id: `in_${name}`, label: name, node, type: 'input', wx: node.x, wy: node.y + (node.h / (inputs.length + 1)) * (i + 1) });
        });
      } else {
        ports.push({ id: 'in', label: '', node, type: 'input', wx: node.x, wy: hc.y });
      }
      ports.push({ id: 'out', label: 'out', node, type: 'output', wx: node.x + node.w, wy: hc.y });
    }
    return ports;
  }

  function findAllInputPorts(excludeNode) {
    const all = [];
    for (const node of nodes) {
      if (node === excludeNode) continue;
      for (const port of getPorts(node)) {
        if (port.type === 'input') all.push(port);
      }
    }
    return all;
  }

  function findAllOutputPorts() {
    const all = [];
    for (const node of nodes) {
      for (const port of getPorts(node)) {
        if (port.type === 'output') all.push(port);
      }
    }
    return all;
  }

  function findPortByWorldPos(wx, wy, excludeNode, preferInput) {
    let best = null, bestDist = SNAP_RADIUS;
    const candidates = preferInput !== false ? findAllInputPorts(excludeNode) : findAllOutputPorts();
    for (const port of candidates) {
      const dist = Math.sqrt((port.wx - wx) ** 2 + (port.wy - wy) ** 2);
      if (dist < bestDist) { bestDist = dist; best = port; }
    }
    return best;
  }

  function portHitTest(sx, sy) {
    for (const node of nodes) {
      for (const port of getPorts(node)) {
        const sp = worldToScreen(port.wx, port.wy);
        if (Math.sqrt((sx - sp.x) ** 2 + (sy - sp.y) ** 2) < PORT_HOVER_RADIUS) return port;
      }
    }
    return null;
  }

  function drawPort(port) {
    const sp = worldToScreen(port.wx, port.wy);
    const connected = edges.some(e => port.type === 'input' ? e.toPortId === port.id && e.toNodeId === port.node.id : e.fromPortId === port.id && e.fromNodeId === port.node.id);
    const isVariable = port.node.type === 'variable';

    if (isVariable && mouseScreen) {
      const dist = Math.sqrt((mouseScreen.x - sp.x) ** 2 + (mouseScreen.y - sp.y) ** 2);
      if (dist > PORT_HOVER_RADIUS && !connected) return;
    }

    const r = Math.max(2, PORT_RADIUS * view.zoom);
    ctx.beginPath(); ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    if (port.type === 'input') { ctx.fillStyle = connected ? '#22c55e' : '#ef4444'; ctx.strokeStyle = connected ? '#16a34a' : '#dc2626'; }
    else { ctx.fillStyle = '#8b5cf6'; ctx.strokeStyle = '#7c3aed'; }
    ctx.lineWidth = Math.max(1, 1.5 * view.zoom);
    ctx.fill(); ctx.stroke();

    if (view.zoom > 0.5 && port.type === 'input' && port.label) {
      ctx.fillStyle = '#d0d0e8';
      ctx.font = `300 ${Math.max(8, 10 * view.zoom)}px 'JetBrains Mono', 'SF Mono', monospace`;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(port.label, sp.x - Math.max(4, r + 3 * view.zoom), sp.y);
    }
  }

  function edgeAtWorldPos(wx, wy) {
    let best = null, bestDist = 10;
    for (const edge of edges) {
      const fromNode = nodes.find(n => n.id === edge.fromNodeId);
      const toNode = nodes.find(n => n.id === edge.toNodeId);
      if (!fromNode || !toNode) continue;
      const fromPort = getPorts(fromNode).find(p => p.id === edge.fromPortId);
      const toPort = getPorts(toNode).find(p => p.id === edge.toPortId);
      if (!fromPort || !toPort) continue;
      const steps = 30;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const bx = (1 - t) * (1 - t) * fromPort.wx + 2 * (1 - t) * t * (fromPort.wx + (toPort.wx - fromPort.wx) * 0.5) + t * t * toPort.wx;
        const by = (1 - t) * (1 - t) * fromPort.wy + 2 * (1 - t) * t * (fromPort.wy + (toPort.wy - fromPort.wy) * 0.5) + t * t * toPort.wy;
        const dist = Math.sqrt((bx - wx) ** 2 + (by - wy) ** 2);
        if (dist < bestDist) { bestDist = dist; best = edge; }
      }
    }
    return best;
  }

  function drawEdge(edge) {
    const fromNode = nodes.find(n => n.id === edge.fromNodeId);
    const toNode = nodes.find(n => n.id === edge.toNodeId);
    if (!fromNode || !toNode) return;
    const fromPort = getPorts(fromNode).find(p => p.id === edge.fromPortId);
    const toPort = getPorts(toNode).find(p => p.id === edge.toPortId);
    if (!fromPort || !toPort) return;
    const start = worldToScreen(fromPort.wx, fromPort.wy);
    const end = worldToScreen(toPort.wx, toPort.wy);
    const cpOff = Math.max(50, Math.abs(end.x - start.x) * 0.4) * view.zoom;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.bezierCurveTo(start.x + cpOff, start.y, end.x - cpOff, end.y, end.x, end.y);
    const isSel = edge === selectedEdge;
    ctx.strokeStyle = isSel ? '#fbbf24' : 'rgba(99, 102, 241, 0.7)';
    ctx.lineWidth = isSel ? Math.max(4, 5 * view.zoom) : Math.max(2, 2.5 * view.zoom);
    ctx.stroke();

    if (isSel && view.zoom > 0.3) {
      const mx = (start.x + end.x) / 2;
      const my = (start.y + end.y) / 2;
      ctx.fillStyle = '#fbbf24';
      ctx.font = `400 ${Math.max(8, 10 * view.zoom)}px 'JetBrains Mono', 'SF Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const label = edge.fromPortId.replace('out', '').replace('in', '') || '';
      ctx.fillText(label, mx + 8 * view.zoom, my - 4 * view.zoom);
    }
  }

  function createEdge(fromNode, fromPortId, toNode, toPortId) {
    if (edges.some(e => e.fromNodeId === fromNode.id && e.fromPortId === fromPortId && e.toNodeId === toNode.id && e.toPortId === toPortId)) return;
    pushUndo();
    edges.push({ fromNodeId: fromNode.id, fromPortId, toNodeId: toNode.id, toPortId });
    markDirty();
  }

  /* ---- Tab init ---- */
  addTab('main');

  /* ---- Nodes ---- */

  function nodeAt(wx, wy) {
    const pad = 8;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (wx >= n.x - pad && wx <= n.x + n.w + pad && wy >= n.y - pad && wy <= n.y + n.h + pad) return n;
    }
    return null;
  }

  function duplicateNode(node) {
    const newN = JSON.parse(JSON.stringify(node));
    newN.id = ++nodeIdCounter;
    newN.x = node.x + 30;
    newN.y = node.y + 30;
    newN.dbId = null;
    nodes.push(newN);
    if (selectedNodes.length <= 1) {
      deselectNode();
      selectNode(newN);
    } else {
      selectedNodes.push(newN);
      selectedNode = newN;
    }
    markDirty();
    render();
  }

  function addNode(type, opts) {
    const cx = (opts?.x !== undefined && opts?.x !== null) ? opts.x : (-view.x) + (Math.random() - 0.5) * 200;
    const cy = (opts?.y !== undefined && opts?.y !== null) ? opts.y : (-view.y) + (Math.random() - 0.5) * 200;
    const n = { id: ++nodeIdCounter, type, x: cx, y: cy, w: 80, h: 60, label: nodes.length + 1 };
    if (type === 'variable') {
      const label = opts?.name ?? `var_${nodes.length + 1}`;
      n.color = '#3b82f6'; n.h = 52; n.w = 150;
      n.label = label;
      fitNodeWidth(n, label, 150, 40);
    } else if (type === 'immutable') {
      const hasVal = opts?.initialized && opts?.immValue;
      n.w = hasVal ? 160 : 130;
      n.h = 60;
      n.color = '#059669';
      n.label = opts?.name ?? `imm_${nodes.length + 1}`;
      n.immValue = opts?.immValue ?? null;
      n.initialized = opts?.initialized ?? false;
    } else if (type === 'function') {
      const fnName = opts?.fnName ?? 'handler';
      n.color = '#8b5cf6'; n.h = 52;
      n.fnName = fnName; n.fnCode = opts?.fnCode ?? '';
      n.fnInputs = opts?.fnInputs ?? ''; n.fnSizeKB = opts?.fnSizeKB ?? 1;
      n.label = n.fnName;
      fitNodeWidth(n, fnName, 180, 50);
      n.label = n.fnName;
    } else {
      n.color = `hsl(${Math.random() * 360}, 60%, 50%)`;
    }
    pushUndo();
    nodes.push(n);
    markDirty();
    selectNode(n);
    render();
  }

  function selectNode(node, addToSelection) {
    if (addToSelection && node) {
      if (selectedNodes.includes(node)) {
        const idx = selectedNodes.indexOf(node);
        selectedNodes.splice(idx, 1);
        if (selectedNodes.length > 0) {
          selectedNode = selectedNodes[selectedNodes.length - 1];
        } else {
          selectedNode = null;
          deselectNode();
          return;
        }
      } else {
        selectedNodes.push(node);
        selectedNode = node;
      }
    } else {
      selectedNode = node;
      selectedNodes = node ? [node] : [];
    }
    if (node?.type === 'function') {
      fnNode = node;
      fnNameInput.value = node.fnName;
      inputsField.value = node.fnInputs;
      document.getElementById('outputsField').value = node.fnOutputs || '';
      fnEditor.value = node.fnCode;
      sizeInput.value = node.fnSizeKB;
      sizeInKB = node.fnSizeKB;
      sizeBarFill.style.width = (node.fnSizeKB / 1024 * 100) + '%';
      sizeUnit.textContent = node.fnSizeKB > 1024 ? 'MB' : 'KB';
      document.getElementById('fnOpSelect').value = node.fnOp || '';
      document.getElementById('fnEndToggle').checked = !!node.fnEnd;
      document.getElementById('opSection').style.display = '';
      document.getElementById('endSection').style.display = '';
    } else {
      fnNode = null;
      document.getElementById('opSection').style.display = 'none';
      document.getElementById('endSection').style.display = 'none';
    }
    updateSelectionUI();
    render();
  }

  function deselectNode() {
    selectedNode = null;
    selectedNodes = [];
    fnNode = null;
    fnNameInput.value = '';
    fnEditor.value = '';
    inputsField.value = '';
    document.getElementById('outputsField').value = '';
    sizeInput.value = 1;
    sizeInKB = 1;
    sizeBarFill.style.width = (1 / 1024 * 100) + '%';
    sizeUnit.textContent = 'KB';
    document.getElementById('fnOpSelect').value = '';
    document.getElementById('fnEndToggle').checked = false;
    document.getElementById('opSection').style.display = 'none';
    document.getElementById('endSection').style.display = 'none';
    updateSelectionUI();
    render();
  }

  function deselectEdge() {
    selectedEdge = null;
    render();
  }

  function updateSelectionUI() {
    if (!selectedNode) { selRing.style.display = 'none'; [rNW, rNE, rSW, rSE].forEach(h => h.style.display = 'none'); return; }

    if (selectedNodes.length > 1) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of selectedNodes) {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x + n.w > maxX) maxX = n.x + n.w;
        if (n.y + n.h > maxY) maxY = n.y + n.h;
      }
      const p1 = worldToScreen(minX, minY);
      const p2 = worldToScreen(maxX, maxY);
      selRing.style.display = 'block';
      selRing.style.left = Math.min(p1.x, p2.x) + 'px';
      selRing.style.top = Math.min(p1.y, p2.y) + 'px';
      selRing.style.width = Math.abs(p2.x - p1.x) + 'px';
      selRing.style.height = Math.abs(p2.y - p1.y) + 'px';
      [rNW, rNE, rSW, rSE].forEach(h => h.style.display = 'block');
      return;
    }

    const p1 = worldToScreen(selectedNode.x, selectedNode.y);
    const p2 = worldToScreen(selectedNode.x + selectedNode.w, selectedNode.y + selectedNode.h);
    selRing.style.display = 'block';
    selRing.style.left = Math.min(p1.x, p2.x) + 'px';
    selRing.style.top = Math.min(p1.y, p2.y) + 'px';
    selRing.style.width = Math.abs(p2.x - p1.x) + 'px';
    selRing.style.height = Math.abs(p2.y - p1.y) + 'px';
    [rNW, rNE, rSW, rSE].forEach(h => h.style.display = 'block');
  }

  function hitTestHandle(pos) {
    const names = ['nw', 'ne', 'sw', 'se'];
    const hs = [rNW, rNE, rSW, rSE];
    const cr = canvas.getBoundingClientRect();
    for (let i = 0; i < 4; i++) {
      const r = hs[i].getBoundingClientRect();
      const hx = r.left - cr.left + r.width / 2, hy = r.top - cr.top + r.height / 2;
      if (Math.abs(pos.x - hx) < 12 && Math.abs(pos.y - hy) < 12) return names[i];
    }
    return null;
  }

  /* ---- Render ---- */

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrid();

    for (const e of edges) drawEdge(e);

    if (isDraggingPort && draggingPort) {
      const start = worldToScreen(draggingPort.wx, draggingPort.wy);
      const end = worldToScreen(dragPortWorld.x, dragPortWorld.y);
      const cpOff = Math.max(50, Math.abs(end.x - start.x) * 0.4) * view.zoom;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.bezierCurveTo(start.x + cpOff, start.y, end.x - cpOff, end.y, end.x, end.y);
      ctx.strokeStyle = snapTarget ? 'rgba(34,197,94,0.8)' : 'rgba(99,102,241,0.5)';
      ctx.lineWidth = Math.max(2, 2.5 * view.zoom);
      ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
      if (snapTarget) {
        const tp = worldToScreen(snapTarget.wx, snapTarget.wy);
        ctx.beginPath(); ctx.arc(tp.x, tp.y, Math.max(4, (PORT_RADIUS + 4) * view.zoom), 0, Math.PI * 2);
        ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2 * view.zoom; ctx.stroke();
      }
    }

    for (const n of nodes) {
      const p1 = worldToScreen(n.x, n.y);
      const p2 = worldToScreen(n.x + n.w, n.y + n.h);
      const left = Math.min(p1.x, p2.x), top = Math.min(p1.y, p2.y);
      const w = Math.abs(p2.x - p1.x), h = Math.abs(p2.y - p1.y);
      const isSel = n === selectedNode;

      ctx.save();
      ctx.fillStyle = n.color;
      ctx.strokeStyle = isSel ? '#fff' : 'rgba(0,0,0,0.15)';
      ctx.lineWidth = isSel ? 3 : 1.5;
      ctx.beginPath();
      ctx.roundRect(left, top, w, h, 8);
      ctx.fill(); ctx.stroke();

      if (n.type === 'variable') {
        ctx.fillStyle = '#ffffff';
        ctx.font = `300 ${Math.max(11, 13 * view.zoom)}px 'Inter', system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(n.label, left + w / 2, top + h / 2);
      } else if (n.type === 'immutable') {
        ctx.fillStyle = '#ffffff';
        ctx.font = `500 ${Math.max(12, 14 * view.zoom)}px 'Inter', system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(n.label, left + w / 2, top + 18 * view.zoom);
        const hasVal = n.initialized && n.immValue !== null;
        if (hasVal && view.zoom > 0.4) {
          const display = n.immValue.length > 20 ? n.immValue.substring(0, 20) + '...' : n.immValue;
          const cw = w - 12 * view.zoom;
          const ch = 22 * view.zoom;
          const cx = left + 6 * view.zoom;
          const cy = top + h - 28 * view.zoom;
          ctx.save();
          ctx.fillStyle = 'rgba(0,0,0,0.15)';
          ctx.strokeStyle = 'rgba(167, 243, 208, 0.3)';
          ctx.lineWidth = 1 * view.zoom;
          ctx.beginPath();
          ctx.roundRect(cx, cy, cw, ch, 4);
          ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#a7f3d0';
          ctx.font = `500 ${Math.max(10, 11 * view.zoom)}px 'JetBrains Mono', 'SF Mono', monospace`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(display, left + w / 2, cy + ch / 2);
          ctx.restore();
        }
      } else if (n.type === 'function') {
        ctx.fillStyle = '#e9d5ff';
        ctx.font = `300 ${Math.max(10, 11 * view.zoom)}px 'JetBrains Mono', 'SF Mono', monospace`;
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText('fn', left + 10, top + h / 2);
        ctx.fillStyle = '#ffffff';
        ctx.font = `300 ${Math.max(12, 14 * view.zoom)}px 'Inter', system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(n.fnName, left + 30, top + h / 2);
      } else {
        ctx.fillStyle = '#1a1a2e';
        ctx.font = `300 ${Math.max(12, 14 * view.zoom)}px 'Inter', system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(n.label, left + w / 2, top + h / 2);
      }
      ctx.restore();
      for (const p of getPorts(n)) drawPort(p);
    }

    if (isBoxSelecting && boxSelectRect) {
      ctx.save();
      ctx.fillStyle = 'rgba(99, 102, 241, 0.08)';
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(boxSelectRect.x, boxSelectRect.y, boxSelectRect.w, boxSelectRect.h);
      ctx.fillRect(boxSelectRect.x, boxSelectRect.y, boxSelectRect.w, boxSelectRect.h);
      ctx.restore();
    }

    updateSelectionUI();
    const selCount = selectedNodes.length > 1 ? ` \u00b7 ${selectedNodes.length} sel` : '';
    document.getElementById('infoDisplay').textContent = `Z: ${Math.round(view.zoom * 100)}% \u00b7 ${nodes.length} nodes \u00b7 ${edges.length} wires${selCount}`;
  }

  const tooltipEl = document.getElementById('nodeTooltip');

  function buildNodeTooltip(node) {
    if (node.type === 'variable') {
      return `Variable: ${node.label}`;
    } else if (node.type === 'immutable') {
      const val = node.initialized && node.immValue !== null ? node.immValue : '(uninitialized)';
      return `Immutable: ${node.label}\nValue: ${val}`;
    } else if (node.type === 'function') {
      const inputs = node.fnInputs ? node.fnInputs.split(',').map(s => s.trim()).filter(Boolean).join(', ') : '(none)';
      return `Function: ${node.fnName}\nInputs: ${inputs}\nSize: ${node.fnSizeKB} KB`;
    }
    return '';
  }

  function showNodeTooltip(node, cx, cy) {
    const text = buildNodeTooltip(node);
    if (!text) return;
    tooltipEl.textContent = text;
    tooltipEl.style.display = 'block';
    let tx = cx + 16, ty = cy + 16;
    if (tx + tooltipEl.offsetWidth > window.innerWidth) tx = cx - tooltipEl.offsetWidth - 8;
    if (ty + tooltipEl.offsetHeight > window.innerHeight) ty = cy - tooltipEl.offsetHeight - 8;
    tooltipEl.style.left = tx + 'px';
    tooltipEl.style.top = ty + 'px';
  }

  function hideNodeTooltip() {
    tooltipEl.style.display = 'none';
  }

  /* ---- Canvas Events ----
     Ctrl/Cmd is a global "mouse lock": while held, every mouse interaction is
     suppressed (panning, port wiring, edge selection, resizing, hovering,
     wheel zoom, right-click editing, palette drops) EXCEPT dragging an
     existing node to reposition it. Canvas panning is still available at all
     times via WASD / arrow keys (handled in the keyboard section below,
     independent of Ctrl state). */

  function getDragOffsets(world) {
    if (selectedNodes.length > 1) {
      const cx = selectedNodes.reduce((s, n) => s + n.x, 0) / selectedNodes.length;
      const cy = selectedNodes.reduce((s, n) => s + n.y, 0) / selectedNodes.length;
      return { x: world.x - cx, y: world.y - cy };
    }
    return null;
  }

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    const isMiddle = e.button === 1;
    if (isMiddle) { e.preventDefault(); isPanning = true; panStart = { x: e.clientX, y: e.clientY }; viewStart = { x: view.x, y: view.y }; return; }
    const pos = { x: e.clientX - canvas.getBoundingClientRect().left, y: e.clientY - canvas.getBoundingClientRect().top };

    if (e.ctrlKey || e.metaKey) {
      const world = screenToWorld(pos.x, pos.y);
      const hit = nodeAt(world.x, world.y);
      if (hit) {
        selectedEdge = null;
        if (e.shiftKey) {
          selectNode(hit, true);
        } else {
          selectNode(hit);
        }
        isDraggingNode = true;
        if (selectedNodes.length > 1) {
          groupDragOffsets = getDragOffsets(world);
        } else {
          dragOffset = { x: world.x - hit.x, y: world.y - hit.y };
        }
      }
      return;
    }

    if (e.shiftKey) {
      const world = screenToWorld(pos.x, pos.y);
      const hit = nodeAt(world.x, world.y);
      if (hit) {
        selectedEdge = null;
        selectNode(hit, true);
        isDraggingNode = true;
        groupDragOffsets = getDragOffsets(world);
        return;
      }
      isBoxSelecting = true;
      multiSelectActive = true;
      boxSelectStart = { x: pos.x, y: pos.y };
      boxSelectRect = null;
      return;
    }

    const hitPort = portHitTest(pos.x, pos.y);
    if (hitPort) {
      isDraggingPort = true; draggingPort = hitPort;
      dragPortWorld = { x: hitPort.wx, y: hitPort.wy }; snapTarget = null;
      return;
    }

    const world = screenToWorld(pos.x, pos.y);

    if (selectedNode) {
      const h = hitTestHandle(pos);
      if (h) { isResizing = true; resizeCorner = h; resizeStart = { x: pos.x, y: pos.y }; nodeStartProps = { x: selectedNode.x, y: selectedNode.y, w: selectedNode.w, h: selectedNode.h }; return; }
    }

    const hitEdge = edgeAtWorldPos(world.x, world.y);
    if (hitEdge && !e.shiftKey) {
      selectedEdge = hitEdge;
      selectedNode = null; selectedNodes = []; fnNode = null;
      updateSelectionUI();
      render();
      return;
    }

    const hit = nodeAt(world.x, world.y);
    if (hit) {
      selectedEdge = null;
      selectNode(hit);
      return;
    }

    deselectNode();
    deselectEdge();
    isPanning = true; panStart = { x: pos.x, y: pos.y }; viewStart = { x: view.x, y: view.y };
  });

  canvas.addEventListener('mousemove', (e) => {
    const pos = { x: e.clientX - canvas.getBoundingClientRect().left, y: e.clientY - canvas.getBoundingClientRect().top };
    mouseScreen = pos;
    mouseWorld = screenToWorld(pos.x, pos.y);

    if (isBoxSelecting) {
      boxSelectRect = { x: Math.min(boxSelectStart.x, pos.x), y: Math.min(boxSelectStart.y, pos.y), w: Math.abs(pos.x - boxSelectStart.x), h: Math.abs(pos.y - boxSelectStart.y) };
      selectedNodes = [];
      const worldTL = screenToWorld(boxSelectRect.x, boxSelectRect.y);
      const worldBR = screenToWorld(boxSelectRect.x + boxSelectRect.w, boxSelectRect.y + boxSelectRect.h);
      const rx1 = Math.min(worldTL.x, worldBR.x), ry1 = Math.min(worldTL.y, worldBR.y);
      const rx2 = Math.max(worldTL.x, worldBR.x), ry2 = Math.max(worldTL.y, worldBR.y);
      for (const n of nodes) {
        if (n.x < rx2 && n.x + n.w > rx1 && n.y < ry2 && n.y + n.h > ry1) selectedNodes.push(n);
      }
      if (selectedNodes.length > 0) selectedNode = selectedNodes[selectedNodes.length - 1];
      else selectedNode = null;
      updateSelectionUI(); render(); return;
    }

    // Node-dragging is allowed to continue even if Ctrl is released mid-drag.
    if (isDraggingNode) {
      const world = screenToWorld(pos.x, pos.y);
      if (selectedNodes.length > 1 && groupDragOffsets) {
        const dx = world.x - groupDragOffsets.x - (selectedNodes.reduce((s, n) => s + n.x, 0) / selectedNodes.length);
        const dy = world.y - groupDragOffsets.y - (selectedNodes.reduce((s, n) => s + n.y, 0) / selectedNodes.length);
        for (const n of selectedNodes) { n.x += dx; n.y += dy; }
        groupDragOffsets = getDragOffsets(world);
      } else if (selectedNode) {
        selectedNode.x = world.x - dragOffset.x;
        selectedNode.y = world.y - dragOffset.y;
      }
      updateSelectionUI(); render(); return;
    }

    if (e.ctrlKey || e.metaKey) {
      hideNodeTooltip();
      canvas.style.cursor = '';
      return;
    }

    if (isDraggingPort && draggingPort) {
      const world = screenToWorld(pos.x, pos.y);
      dragPortWorld.x = world.x; dragPortWorld.y = world.y;
      const preferInput = draggingPort.type === 'output';
      snapTarget = findPortByWorldPos(world.x, world.y, draggingPort.node, preferInput);
      render(); return;
    }

    if (isResizing && selectedNode) {
      const n = selectedNode; const dx = (pos.x - resizeStart.x) / view.zoom; const dy = (pos.y - resizeStart.y) / view.zoom; const sx = nodeStartProps;
      if (resizeCorner === 'se') { n.w = Math.max(20, sx.w + dx); n.h = Math.max(20, sx.h + dy); }
      else if (resizeCorner === 'sw') { n.w = Math.max(20, sx.w - dx); n.h = Math.max(20, sx.h + dy); n.x = sx.x + (sx.w - n.w); }
      else if (resizeCorner === 'ne') { n.w = Math.max(20, sx.w + dx); n.h = Math.max(20, sx.h - dy); n.y = sx.y + (sx.h - n.h); }
      else if (resizeCorner === 'nw') { n.w = Math.max(20, sx.w - dx); n.h = Math.max(20, sx.h - dy); n.x = sx.x + (sx.w - n.w); n.y = sx.y + (sx.h - n.h); }
      updateSelectionUI(); render(); return;
    }

    if (isPanning) {
      view.x = viewStart.x + (pos.x - panStart.x) / view.zoom;
      view.y = viewStart.y + (pos.y - panStart.y) / view.zoom;
      render(); return;
    }

    const hoveredNode = mouseWorld ? nodeAt(mouseWorld.x, mouseWorld.y) : null;
    if (hoveredNode && !isDraggingNode && !isDraggingPort && !isResizing && !isPanning && !isBoxSelecting) {
      showNodeTooltip(hoveredNode, e.clientX, e.clientY);
    } else {
      hideNodeTooltip();
    }

    if (selectedNode) canvas.style.cursor = hitTestHandle(pos) ? 'pointer' : '';
    else if (mouseWorld && edgeAtWorldPos(mouseWorld.x, mouseWorld.y)) canvas.style.cursor = 'pointer';
    else canvas.style.cursor = '';
  });

  canvas.addEventListener('mouseup', () => {
    if (isBoxSelecting && boxSelectRect && boxSelectRect.w < 10 && boxSelectRect.h < 10 && !multiSelectActive) {
      deselectNode();
    }
    if (isBoxSelecting && selectedNodes.length > 0) {
      selectedNode = selectedNodes[selectedNodes.length - 1];
    }
    if (isDraggingPort && draggingPort && snapTarget) {
      const srcPort = draggingPort.type === 'output' ? draggingPort : snapTarget;
      const dstPort = draggingPort.type === 'output' ? snapTarget : draggingPort;
      createEdge(srcPort.node, srcPort.id, dstPort.node, dstPort.id);
    }
    if (isDraggingNode || isResizing || isBoxSelecting) markDirty();
    isPanning = false; isDraggingNode = false; isResizing = false; isDraggingPort = false; isBoxSelecting = false;
    multiSelectActive = false;
    draggingPort = null; snapTarget = null; groupDragOffsets = null; boxSelectRect = null; canvas.style.cursor = '';
    mouseScreen = null; mouseWorld = null;
    render();
  });

  canvas.addEventListener('mouseleave', () => {
    isPanning = false; isDraggingNode = false; isResizing = false; isDraggingPort = false; isBoxSelecting = false;
    draggingPort = null; snapTarget = null; groupDragOffsets = null; boxSelectRect = null; multiSelectActive = false;
    mouseScreen = null; mouseWorld = null;
    hideNodeTooltip();
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) return;
    const dir = -Math.sign(e.deltaY);
    const factor = dir > 0 ? 1.15 : 1 / 1.15;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const world = screenToWorld(cx, cy);
    const newZoom = Math.min(5, Math.max(0.1, view.zoom * factor));
    view.x = world.x - (cx - canvas.width / 2) / newZoom;
    view.y = world.y - (cy - canvas.height / 2) / newZoom;
    view.zoom = newZoom;
    render();
  }, { passive: false });

  const contextMenu = document.createElement('div');
  contextMenu.id = 'canvasContextMenu';
  contextMenu.style.cssText = 'position:fixed;z-index:3001;background:rgba(26,26,46,0.98);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.1);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.6);padding:4px;font-family:Inter,system-ui,sans-serif;font-weight:300;font-size:13px;display:none;min-width:180px;';
  contextMenu.innerHTML = `
    <div class="ctx-item" data-action="variable"><i class="fa-solid fa-cube" style="width:18px;color:#3b82f6"></i> Add Variable</div>
    <div class="ctx-item" data-action="immutable"><i class="fa-solid fa-lock" style="width:18px;color:#059669"></i> Add Immutable</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-action="duplicate"><i class="fa-regular fa-clone" style="width:18px;color:#8888aa"></i> Duplicate</div>
    <div class="ctx-item" data-action="delete"><i class="fa-solid fa-trash-can" style="width:18px;color:#ef4444"></i> Delete</div>
  `;
  const ctxItemStyle = document.createElement('style');
  ctxItemStyle.textContent = `.ctx-item{padding:8px 12px;border-radius:6px;cursor:pointer;color:#c8c8e8;display:flex;align-items:center;gap:8px;transition:0.1s}.ctx-item:hover{background:rgba(99,102,241,0.2);color:#e0e0f0}.ctx-sep{height:1px;background:rgba(255,255,255,0.06);margin:4px 8px}`;
  contextMenu.appendChild(ctxItemStyle);
  document.body.appendChild(contextMenu);

  let ctxMenuWorld = null;
  let ctxMenuTarget = null;

  contextMenu.addEventListener('mousedown', (e) => {
    const action = e.target.closest('.ctx-item')?.dataset?.action;
    if (!action) return;
    contextMenu.style.display = 'none';
    if (action === 'variable') {
      if (ctxMenuWorld) { pendingVarPos = ctxMenuWorld; showVarModal(); }
    } else if (action === 'immutable') {
      if (ctxMenuWorld) { pendingImmPos = ctxMenuWorld; showImmModal(); }
    } else if (action === 'duplicate') {
      if (selectedNodes.length > 0) {
        pushUndo();
        const toDup = [...selectedNodes];
        deselectNode();
        for (const n of toDup) duplicateNode(n);
      } else if (selectedNode) {
        pushUndo();
        duplicateNode(selectedNode);
      }
    } else if (action === 'delete') {
      if (selectedNode || selectedNodes.length > 0) {
        pushUndo();
        if (selectedNodes.length > 0) {
          const ids = new Set(selectedNodes.map(n => n.id));
          for (let i = nodes.length - 1; i >= 0; i--) { if (ids.has(nodes[i].id)) nodes.splice(i, 1); }
          for (let i = edges.length - 1; i >= 0; i--) { if (ids.has(edges[i].fromNodeId) || ids.has(edges[i].toNodeId)) edges.splice(i, 1); }
        } else {
          const sid = selectedNode.id;
          const idx = nodes.indexOf(selectedNode);
          if (idx !== -1) nodes.splice(idx, 1);
          for (let i = edges.length - 1; i >= 0; i--) { if (edges[i].fromNodeId === sid || edges[i].toNodeId === sid) edges.splice(i, 1); }
        }
        markDirty();
        deselectNode();
        render();
      }
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (contextMenu.style.display !== 'none' && !contextMenu.contains(e.target)) contextMenu.style.display = 'none';
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) return;
    const world = screenToWorld(e.clientX - canvas.getBoundingClientRect().left, e.clientY - canvas.getBoundingClientRect().top);
    const hit = nodeAt(world.x, world.y);
    ctxMenuWorld = world;
    ctxMenuTarget = hit;

    if (hit) {
      if (!selectedNodes.includes(hit) && selectedNode !== hit) {
        selectNode(hit);
      }
    } else {
      deselectNode();
      deselectEdge();
    }

    if (hit && hit.type === 'variable') {
      editingVar = hit;
      document.getElementById('varModalTitle').textContent = 'Edit Variable';
      document.getElementById('varNameInput').value = hit.label;
      document.getElementById('varModal').style.display = 'flex';
      document.getElementById('varNameInput').focus();
      return;
    } else if (hit && hit.type === 'immutable') {
      editingImm = hit;
      document.getElementById('immModalTitle').textContent = 'Edit Immutable';
      document.getElementById('immNameInput').value = hit.label;
      document.getElementById('immValueInput').value = hit.immValue ?? '';
      document.getElementById('immInitialized').checked = hit.initialized;
      document.getElementById('immModal').style.display = 'flex';
      document.getElementById('immNameInput').focus();
      return;
    }

    contextMenu.style.left = e.clientX + 'px';
    contextMenu.style.top = e.clientY + 'px';
    const dupItem = contextMenu.querySelector('[data-action="duplicate"]');
    const delItem = contextMenu.querySelector('[data-action="delete"]');
    if (dupItem) dupItem.style.display = selectedNode || selectedNodes.length > 0 ? 'flex' : 'none';
    if (delItem) delItem.style.display = selectedNode || selectedNodes.length > 0 ? 'flex' : 'none';
    contextMenu.style.display = 'block';
  });

  /* ---- Var Modal ---- */

  function stopMovementIfModal() {
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    velX = 0; velY = 0;
  }

  function showVarModal() {
    stopMovementIfModal();
    document.getElementById('varModalTitle').textContent = 'New Variable';
    document.getElementById('varModal').style.display = 'flex';
    document.getElementById('varNameInput').value = '';
    document.getElementById('varNameInput').focus();
  }

  function hideVarModal() {
    document.getElementById('varModal').style.display = 'none';
    pendingVarPos = null;
  }

  document.getElementById('varModalCancel').addEventListener('click', () => { hideVarModal(); editingVar = null; });
  document.getElementById('varNameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('varModalConfirm').click();
    if (e.key === 'Escape') hideVarModal();
  });
  document.getElementById('varModalConfirm').addEventListener('click', () => {
    if (editingVar) {
      editingVar.label = document.getElementById('varNameInput').value.trim() || editingVar.label;
      editingVar = null; hideVarModal(); markDirty(); render(); return;
    }
    if (!pendingVarPos) return;
    addNode('variable', {
      x: pendingVarPos.x, y: pendingVarPos.y,
      name: document.getElementById('varNameInput').value.trim() || `var_${nodes.length + 1}`,
    });
    hideVarModal();
  });

  /* ---- Immutable Modal ---- */

  function showImmModal() {
    stopMovementIfModal();
    document.getElementById('immModalTitle').textContent = 'New Immutable';
    document.getElementById('immModal').style.display = 'flex';
    document.getElementById('immNameInput').value = '';
    document.getElementById('immValueInput').value = '';
    document.getElementById('immInitialized').checked = false;
    document.getElementById('immNameInput').focus();
  }

  function hideImmModal() {
    document.getElementById('immModal').style.display = 'none';
    pendingImmPos = null;
  }

  document.getElementById('immValueInput').addEventListener('input', () => {
    document.getElementById('immInitialized').checked = document.getElementById('immValueInput').value.trim() !== '';
  });

  document.getElementById('immModalCancel').addEventListener('click', () => { hideImmModal(); editingImm = null; });
  document.getElementById('immNameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('immModalConfirm').click();
    if (e.key === 'Escape') hideImmModal();
  });
  document.getElementById('immModalConfirm').addEventListener('click', () => {
    const val = document.getElementById('immValueInput').value.trim();
    const initialized = val !== '';
    if (editingImm) {
      editingImm.label = document.getElementById('immNameInput').value.trim() || editingImm.label;
      editingImm.immValue = val || null;
      editingImm.initialized = initialized;
      editingImm.w = initialized && val ? 160 : 130;
      editingImm.h = 60;
      editingImm = null; hideImmModal(); markDirty(); render(); return;
    }
    if (!pendingImmPos) return;
    addNode('immutable', {
      x: pendingImmPos.x, y: pendingImmPos.y,
      name: document.getElementById('immNameInput').value.trim() || `imm_${nodes.length + 1}`,
      immValue: val || null,
      initialized,
    });
    hideImmModal();
  });
  /* ---- Variable Drag & Drop ---- */

  document.getElementById('btnAddVariable').addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'variable'); e.dataTransfer.effectAllowed = 'copy'; });
  document.getElementById('btnAddImmutable').addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'immutable'); e.dataTransfer.effectAllowed = 'copy'; });
  let dragOverFrame = null;
  canvas.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOverFrame) {
      dragOverFrame = requestAnimationFrame(() => { dragOverFrame = null; });
    }
  });
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) return; // Mouse lock: dropping new nodes suppressed too.
    const type = e.dataTransfer.getData('text/plain');
    const rect = canvas.getBoundingClientRect();
    const pos = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    if (type === 'variable') {
      pendingVarPos = pos;
      showVarModal();
    } else if (type === 'immutable') {
      pendingImmPos = pos;
      showImmModal();
    }
  });

  /* ---- Sidebar Sync ---- */

  fnEditor.addEventListener('input', markDirty);
  inputsField.addEventListener('input', markDirty);
  sizeInput.addEventListener('input', markDirty);
  fnNameInput.addEventListener('input', markDirty);

  let syncFnTimeout = null;

  function syncFnNode() {
    if (syncFnTimeout) cancelAnimationFrame(syncFnTimeout);
    syncFnTimeout = requestAnimationFrame(() => {
      syncFnTimeout = null;
      if (fnNode && fnNode === selectedNode && document.querySelector('.modal-overlay[style*="flex"]') === null) {
        fnNode.fnName = fnNameInput.value.trim() || 'handler';
        fnNode.fnCode = fnEditor.value;
        fnNode.fnInputs = inputsField.value;
        fnNode.fnOutputs = document.getElementById('outputsField').value;
        fnNode.fnSizeKB = sizeInKB;
        fnNode.fnOp = document.getElementById('fnOpSelect').value;
        fnNode.fnEnd = document.getElementById('fnEndToggle').checked;
        fnNode.label = fnNode.fnName;
        render();
      }
    });
  }

  fnEditor.addEventListener('input', syncFnNode);
  inputsField.addEventListener('input', syncFnNode);
  sizeInput.addEventListener('input', syncFnNode);
  fnNameInput.addEventListener('input', syncFnNode);
  document.getElementById('fnOpSelect').addEventListener('change', syncFnNode);
  document.getElementById('fnEndToggle').addEventListener('change', syncFnNode);

  /* ---- Activity Bar ---- */

  function switchActivityPanel(panelId) {
    document.querySelectorAll('.activity-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.sidebar-panel').forEach(el => el.classList.remove('active'));
    const actItem = document.querySelector(`.activity-item[data-panel="${panelId}"]`);
    if (actItem) actItem.classList.add('active');
    const panel = document.getElementById(`panel-${panelId}`);
    if (panel) panel.classList.add('active');
  }

  document.querySelectorAll('.activity-item').forEach(el => {
    el.addEventListener('click', () => {
      const panel = el.dataset.panel;
      const wasActive = el.classList.contains('active');
      if (wasActive) {
        el.classList.remove('active');
        document.getElementById(`panel-${panel}`)?.classList.remove('active');
      } else {
        switchActivityPanel(panel);
      }
    });
  });

  function syncSettingsToSidebar() {
    const memInput = document.getElementById('sidebarMemory');
    const immInput = document.getElementById('sidebarImmPct');
    const cycInput = document.getElementById('sidebarCycles');
    if (memInput) memInput.value = projectSettings.memory || 8192;
    if (immInput) immInput.value = projectSettings.immutable_pct || 3;
    if (cycInput) cycInput.value = projectSettings.max_cycles || 1000;
  }

  function applySettingsFromSidebar() {
    const memInput = document.getElementById('sidebarMemory');
    const immInput = document.getElementById('sidebarImmPct');
    const cycInput = document.getElementById('sidebarCycles');
    if (memInput) projectSettings.memory = Math.max(256, parseInt(memInput.value, 10) || 8192);
    if (immInput) projectSettings.immutable_pct = Math.max(1, Math.min(50, parseInt(immInput.value, 10) || 3));
    if (cycInput) projectSettings.max_cycles = Math.max(1, parseInt(cycInput.value, 10) || 1000);
  }

  document.getElementById('sidebarMemory')?.addEventListener('input', () => { applySettingsFromSidebar(); markDirty(); });
  document.getElementById('sidebarImmPct')?.addEventListener('input', () => { applySettingsFromSidebar(); markDirty(); });
  document.getElementById('sidebarCycles')?.addEventListener('input', () => { applySettingsFromSidebar(); markDirty(); });

  document.getElementById('btnCreateFn').addEventListener('click', () => {
    const name = fnNameInput.value.trim() || 'handler';
    const op = document.getElementById('fnOpSelect').value;
    const end = document.getElementById('fnEndToggle').checked;
    const inputs = inputsField.value;
    const code = fnEditor.value;
    const mem = sizeInKB || 1;
    const cx = -view.x + (Math.random() - 0.5) * 200;
    const cy = -view.y + (Math.random() - 0.5) * 200;
    addNode('function', { x: cx, y: cy, fnName: name, fnOp: op, fnEnd: end, fnInputs: inputs, fnCode: code, fnSizeKB: mem });
    outputBox.textContent = `Added function '${name}' to canvas`;
    outputBox.classList.add('has-output');
  });

  /* ---- Size ---- */

  function updateSizeDisplay() {
    let val = parseInt(sizeInput.value, 10);
    if (isNaN(val) || val < 1) val = 1;
    if (val > 1024) val = 1024;
    sizeInput.value = val; sizeInKB = val;
    sizeUnit.textContent = 'KB';
    sizeBarFill.style.width = (val / 1024 * 100) + '%';
  }

  sizeInput.addEventListener('input', () => {
    let val = parseInt(sizeInput.value, 10);
    if (isNaN(val) || val < 1) { sizeBarFill.style.width = '0%'; sizeUnit.textContent = 'KB'; return; }
    if (val > 1024) { val = 1; sizeInput.value = val; sizeUnit.textContent = 'MB'; sizeInKB = 1024; }
    else { sizeUnit.textContent = 'KB'; sizeInKB = val; }
    sizeBarFill.style.width = (sizeInKB / 1024 * 100) + '%';
  });
  sizeInput.addEventListener('blur', updateSizeDisplay);

  /* ---- Compile (via Ampersand Compiler API) ---- */

  function serializeCanvasToAdg() {
    const flat = [];
    for (let i = 0; i < nodes.length; i++) flat.push(nodes[i]);
    return {
      functions: flat.filter(n => n.type === 'function').map(n => ({
        dbId: n.dbId ?? null, fnName: n.fnName, fnCode: n.fnCode,
        fnInputs: n.fnInputs, fnOutputs: n.fnOutputs || '',
        fnSizeKB: n.fnSizeKB,
        fnOp: n.fnOp || '', fnEnd: !!n.fnEnd, x: n.x, y: n.y,
      })),
      variables: flat.filter(n => n.type === 'variable').map(n => ({
        dbId: n.dbId ?? null, label: n.label, x: n.x, y: n.y,
      })),
      immutables: flat.filter(n => n.type === 'immutable').map(n => ({
        dbId: n.dbId ?? null, label: n.label,
        immValue: n.immValue, initialized: n.initialized, x: n.x, y: n.y,
      })),
      edges: edges.map(e => {
        const fromNode = nodes.find(n => n.id === e.fromNodeId);
        const toNode = nodes.find(n => n.id === e.toNodeId);
        return {
          fromName: fromNode ? (fromNode.fnName || fromNode.label) : '',
          fromPortId: e.fromPortId,
          toName: toNode ? (toNode.fnName || toNode.label) : '',
          toPortId: e.toPortId,
        };
      }),
      settings: { ...projectSettings },
    };
  }

  function runCompile() {
    const canvasData = serializeCanvasToAdg();

    outputBox.innerHTML = '<span style="color:#8888aa">Compiling via Ampersand Engine...</span>';
    outputBox.classList.add('has-output');

    apiPost('compile', {
      project_id: currentProjectId,
      functions: canvasData.functions,
      variables: canvasData.variables,
      immutables: canvasData.immutables,
      edges: canvasData.edges,
    }).then(data => {
      if (data.adg) {
        console.log('Generated .adg:\n' + data.adg);
      }

      let html = '';

      if (data.ok && data.output) {
        html += '<span style="color:#22c55e">\u2713 Lifecycle completed</span>\n\n';
        html += escapeHtml(data.output);
      }

      if (data.errors && data.errors.length > 0) {
        html += '\n\n<div style="color:#ef4444;font-weight:600">\u2716 Compilation Errors</div>\n';
        html += data.errors.map(e => {
          let errClass = 'error-' + (e.kind || 'unknown');
          return `<div class="${errClass}" style="color:#f87171;padding:2px 0">[LAW ${e.kind}] ${escapeHtml(e.msg)}</div>`;
        }).join('');
      }

      if (data.log) {
        html += '\n\n<div style="color:#8888aa;font-weight:500">-- Engine Log --</div>\n';
        html += '<span style="color:#a0a0c0">' + escapeHtml(data.log) + '</span>';
      }

      if (!data.ok && !data.errors) {
        if (data.error) html = '<span style="color:#ef4444">Error: ' + escapeHtml(data.error) + '</span>';
        else html = '<span style="color:#ef4444">' + escapeHtml(data.raw_output || 'Compilation failed') + '</span>';
      }

      if (data.ok && !data.output && !data.errors) {
        html = '<span style="color:#22c55e">\u2713 Lifecycle completed (no output)</span>';
      }

      outputBox.innerHTML = html || '<span style="color:#8888aa">Lifecycle completed (no output)</span>';
      outputBox.classList.add('has-output');

      // Scroll to top of output to see errors
      outputBox.scrollTop = 0;
    }).catch(err => {
      outputBox.innerHTML = '<span style="color:#ef4444">API Error: ' + escapeHtml(err.message || 'request failed') + '</span>';
      outputBox.classList.add('has-output');
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* ---- Nav Buttons ---- */

  document.getElementById('navCompile').addEventListener('click', runCompile);
  // navTest removed

  function generateAdgText() {
    const allNodes = nodes.slice();
    const nameByIndex = {};
    allNodes.forEach((n, i) => { nameByIndex[i] = n.fnName || n.label || `node_${i}`; });

    let adg = '# Ampersand DataGraph\n';
    adg += `# Coordinates: x,y positions follow each node declaration\n`;
    adg += `graph ${programName.replace(/[^a-zA-Z0-9_]/g, '_')};\n`;
    adg += `setting memory: ${projectSettings.memory || 8192};\n`;
    adg += `setting immutable_pct: ${projectSettings.immutable_pct || 3};\n`;
    adg += `setting max_cycles: ${projectSettings.max_cycles || 1000};\n\n`;

    const hasEntry = allNodes.some(n => (n.type === 'function' && (n.fnName === 'entry')));
    const hasResult = allNodes.some(n => (n.type === 'function' && (n.fnName === 'result')));
    if (!hasEntry) adg += 'node entry entry;  # pos: -300, -100\n';
    if (!hasResult) adg += 'node result result;  # pos: 800, -100\n';

    for (const n of allNodes) {
      const name = n.fnName || n.label || 'unnamed';
      const posstr = `# pos: ${Math.round(n.x)}, ${Math.round(n.y)} w:${Math.round(n.w)} h:${Math.round(n.h)}`;
      if (n.type === 'function') {
        const inputs = (n.fnInputs || '').split(',').map(s => s.trim()).filter(Boolean);
        const outputs = (n.fnOutputs || '').split(',').map(s => s.trim()).filter(Boolean);
        const code = n.fnCode || '';
        const mem = n.fnSizeKB || 1;
        const endAttr = n.fnEnd ? ', end: true' : '';

        adg += `node function ${name} {\n`;
        if (inputs.length > 0) {
          adg += `    inputs: [${inputs.join(', ')}];\n`;
        }
        if (outputs.length > 0) {
          adg += `    outputs: [${outputs.join(', ')}];\n`;
        }
        adg += `    mem: ${mem}${endAttr};\n`;
        if (code.trim()) {
          adg += `    code: "${code.replace(/"/g, '\\"').replace(/\n/g, '\\n')}";\n`;
        }
        adg += `};  ${posstr}\n`;
      } else if (n.type === 'variable') {
        adg += `node variable ${name};  ${posstr}\n`;
      } else if (n.type === 'immutable') {
        const val = n.immValue || '';
        const init = n.initialized && val;
        if (init) {
          adg += `node immutable ${name} { value: "${val}" };  ${posstr}\n`;
        } else {
          adg += `node immutable ${name};  ${posstr}\n`;
        }
      }
    }

    adg += '\n';
    for (const e of edges) {
      const fromIdx = allNodes.findIndex(n => (n.id === e.fromNodeId));
      const toIdx = allNodes.findIndex(n => (n.id === e.toNodeId));
      const fromName = fromIdx >= 0 ? (allNodes[fromIdx].fnName || allNodes[fromIdx].label) : `idx_${e.fromNodeId}`;
      const toName = toIdx >= 0 ? (allNodes[toIdx].fnName || allNodes[toIdx].label) : `idx_${e.toNodeId}`;
      if (fromName && toName) adg += `edge ${fromName} -> ${toName};\n`;
    }

    return adg;
  }



  document.getElementById('navLoadAdg').addEventListener('click', () => {
    document.getElementById('adgFileInput').click();
  });

  document.getElementById('adgFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      const tabName = file.name.replace(/\.adg$/i, '') || 'imported';
      addTab(tabName, text);
      outputBox.textContent = `Loaded ${file.name} (${text.length} chars)`;
      outputBox.classList.add('has-output');
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  document.getElementById('navNewTab').addEventListener('click', () => {
    const name = prompt('Graph name:', 'graph_' + (tabs.length + 1));
    if (name) addTab(name.replace(/[^a-zA-Z0-9_]/g, '_'));
  });

  function parseAdgToCanvasInner(adgText, targetNodes, targetEdges) {
    const nameNodeMap = {};
    const lines = adgText.split('\n');
    let originCount = 0;

    function parsePos(line) {
      const m = line.match(/#\s*pos:\s*([-\d.]+)\s*,\s*([-\d.]+)/);
      const mw = line.match(/w:(\d+)/);
      const mh = line.match(/h:(\d+)/);
      const base = m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : null;
      if (base && (mw || mh)) { base.w = mw ? parseInt(mw[1]) : undefined; base.h = mh ? parseInt(mh[1]) : undefined; }
      return base;
    }

    function spreadOrigin() {
      originCount++;
      const angle = originCount * 2.399;
      const r = 120 + Math.floor(originCount / 8) * 80;
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    }

    function localAddNode(type, opts) {
      const cx = (opts?.x !== undefined && opts?.x !== null) ? opts.x : spreadOrigin().x;
      const cy = (opts?.y !== undefined && opts?.y !== null) ? opts.y : spreadOrigin().y;
      const id = ++nodeIdCounter;
      const n = { id, type, x: cx, y: cy, w: 80, h: 60, label: 'node_' + id };
      if (type === 'variable') {
        const label = opts?.name ?? 'var_' + id;
        n.color = '#3b82f6'; n.h = 52; n.w = 150;
        n.label = label;
      } else if (type === 'immutable') {
        const hasVal = opts?.initialized && opts?.immValue;
        n.w = hasVal ? 160 : 130;
        n.h = 60;
        n.color = '#059669';
        n.label = opts?.name ?? 'imm_' + id;
        n.immValue = opts?.immValue ?? null;
        n.initialized = opts?.initialized ?? false;
      } else if (type === 'function') {
        const fnName = opts?.fnName ?? 'handler';
        n.color = '#8b5cf6'; n.h = 52;
        n.fnName = fnName; n.fnCode = opts?.fnCode ?? '';
        n.fnInputs = opts?.fnInputs ?? ''; n.fnOutputs = opts?.fnOutputs ?? '';
        n.fnSizeKB = opts?.fnSizeKB ?? 1;
        n.fnOp = opts?.fnOp || '';
        n.fnEnd = !!opts?.fnEnd;
        n.label = fnName;
      } else {
        n.color = '#8b5cf6';
      }
      targetNodes.push(n);
      return n;
    }

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('//')) continue;
      if (line.startsWith('setting ')) continue;

      if (line.startsWith('node ')) {
        const m = line.match(/node\s+(variable|function|immutable|entry|result|store)\s+(\w[\w.]*)/);
        if (!m) continue;
        const kind = m[1];
        const name = m[2];
        nameNodeMap[name] = null;

        const attrBlock = line.match(/\{(.+?)\}/);
        let value = '';
        let initialized = false;
        let isEnd = false;
        let fnOp = '';
        let fnInputs = '';
        let fnOutputs = '';
        let fnCode = '';
        if (attrBlock) {
          const raw = attrBlock[1];
          const inputsM = raw.match(/inputs\s*:\s*\[([^\]]*)\]/);
          if (inputsM) fnInputs = inputsM[1].split(',').map(s => s.trim()).filter(Boolean).join(', ');
          const outputsM = raw.match(/outputs\s*:\s*\[([^\]]*)\]/);
          if (outputsM) fnOutputs = outputsM[1].split(',').map(s => s.trim()).filter(Boolean).join(', ');
          const codeM = raw.match(/code\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (codeM) fnCode = codeM[1].replace(/\\n/g, '\n');
          const attrs = raw.split(',').map(s => s.trim());
          for (const a of attrs) {
            const parts = a.split(':').map(s => s.trim().replace(/^"|"$/g, ''));
            if (parts.length < 2) continue;
            const k = parts[0], v = parts[1];
            if (k === 'value') { value = v; initialized = true; }
            if (k === 'end' && v === 'true') isEnd = true;
            if (k === 'op') fnOp = v;
          }
        }

        const pos = parsePos(line) || spreadOrigin();

        if (kind === 'entry' || name === 'entry') {
          localAddNode('function', { name: 'entry', fnName: 'entry', x: pos.x, y: pos.y, fnEnd: isEnd });
        } else if (kind === 'result' || name === 'result') {
          localAddNode('function', { name: 'result', fnName: 'result', x: pos.x, y: pos.y, fnEnd: true });
        } else if (kind === 'variable') {
          localAddNode('variable', { name, x: pos.x, y: pos.y });
        } else if (kind === 'immutable') {
          localAddNode('immutable', { name, immValue: value || null, initialized, x: pos.x, y: pos.y });
        } else if (kind === 'function') {
          const memM = line.match(/mem:\s*([\d.]+)/);
          localAddNode('function', {
            name, fnName: name, fnOp: fnOp, fnInputs: fnInputs, fnOutputs: fnOutputs, fnCode: fnCode,
            fnSizeKB: memM ? parseInt(memM[1]) : 1,
            fnEnd: isEnd, x: pos.x, y: pos.y,
          });
        }

        const last = targetNodes[targetNodes.length - 1];
        if (last && pos.w) last.w = pos.w;
        if (last && pos.h) last.h = pos.h;
        nameNodeMap[name] = last;
        continue;
      }

      if (line.startsWith('edge ')) {
        const m = line.match(/edge\s+(\w[\w.]*)\s*->\s*(\w[\w.]*)/);
        if (!m) continue;
        const src = nameNodeMap[m[1]];
        const dst = nameNodeMap[m[2]];
        if (src && dst) {
          targetEdges.push({ fromNodeId: src.id, fromPortId: 'out', toNodeId: dst.id, toPortId: 'in' });
        }
      }
    }
  }

  // publishFn removed
  /* ---- Zoom ---- */

  document.getElementById('btnZoomIn').addEventListener('click', () => { view.zoom = Math.min(5, view.zoom * 1.3); render(); });
  document.getElementById('btnZoomOut').addEventListener('click', () => { view.zoom = Math.max(0.1, view.zoom / 1.3); render(); });
  document.getElementById('btnReset').addEventListener('click', () => { view = { x: 0, y: 0, zoom: 1 }; render(); });

  /* ---- Keyboard ---- */

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveToDatabase(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveToFile(true); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); searchInput.focus(); searchInput.select(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runCompile(); return; }
    if (e.shiftKey && (e.key === 'C' || e.key === 'c')) { e.preventDefault(); fnEditor.focus(); return; }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); redo(); return; }

    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      if (selectedNodes.length > 0) {
        pushUndo();
        const toDup = [...selectedNodes];
        deselectNode();
        for (const n of toDup) duplicateNode(n);
      } else if (selectedNode) {
        pushUndo();
        duplicateNode(selectedNode);
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      if (document.activeElement?.closest('#sidebar')) return;
      selectedNodes = [...nodes];
      if (selectedNodes.length > 0) selectedNode = selectedNodes[selectedNodes.length - 1];
      updateSelectionUI();
      render();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && ['1','2','3','4'].includes(e.key)) {
      e.preventDefault();
      if (document.activeElement?.closest('#sidebar') || document.activeElement?.closest('input,textarea')) return;
      const map = { '1': 'fn', '2': 'settings', '3': 'ai', '4': 'output' };
      const panel = map[e.key];
      const actItem = document.querySelector(`.activity-item[data-panel="${panel}"]`);
      if (actItem) {
        const wasActive = actItem.classList.contains('active');
        if (wasActive) {
          actItem.classList.remove('active');
          document.getElementById(`panel-${panel}`)?.classList.remove('active');
        } else {
          switchActivityPanel(panel);
          if (panel === 'settings') syncSettingsToSidebar();
        }
      }
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (document.activeElement?.closest('#sidebar')) return;
      if (selectedEdge) {
        pushUndo();
        const idx = edges.indexOf(selectedEdge);
        if (idx !== -1) edges.splice(idx, 1);
        markDirty();
        deselectEdge();
        return;
      }
      if (selectedNodes.length > 0) {
        pushUndo();
        const ids = new Set(selectedNodes.map(n => n.id));
        for (let i = nodes.length - 1; i >= 0; i--) { if (ids.has(nodes[i].id)) nodes.splice(i, 1); }
        for (let i = edges.length - 1; i >= 0; i--) { if (ids.has(edges[i].fromNodeId) || ids.has(edges[i].toNodeId)) edges.splice(i, 1); }
        markDirty();
        deselectNode();
        render();
        return;
      }
      if (selectedNode) {
        pushUndo();
        const sid = selectedNode.id;
        const idx = nodes.indexOf(selectedNode);
        if (idx !== -1) nodes.splice(idx, 1);
        for (let i = edges.length - 1; i >= 0; i--) { if (edges[i].fromNodeId === sid || edges[i].toNodeId === sid) edges.splice(i, 1); }
        markDirty();
        deselectNode();
      }
    }
    if (e.key === 'Escape') {
      if (document.activeElement && document.activeElement.closest('#sidebar')) { document.activeElement.blur(); return; }
      if (selectedEdge) { deselectEdge(); return; }
      if (selectedNodes.length > 1) { selectedNodes = [selectedNode]; updateSelectionUI(); render(); return; }
      deselectNode();
    }

    const isInput = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.closest('#sidebar'));
    if (isInput) return;

    keysDown[e.code] = true;
    startMovementLoop();
  });

  document.addEventListener('keyup', (e) => { keysDown[e.code] = false; });

  /* ---- @ Autocomplete ---- */

  function getAllNodeIdentifiers() {
    const ids = [];
    for (const n of nodes) { if (n.type === 'variable') ids.push(n.label); if (n.type === 'immutable') ids.push(n.label); if (n.type === 'function') ids.push(n.fnName); }
    return [...new Set(ids)];
  }

  function showAutocomplete(field, triggerPos) {
    autoCompleteField = field; autoCompleteTriggerPos = triggerPos; autoCompleteActive = true; autoCompleteIdx = 0;
    const text = field.value.substring(0, field.selectionStart);
    const query = text.substring(text.lastIndexOf('@') + 1);
    autoCompleteResults = getAllNodeIdentifiers().filter(id => id.toLowerCase().includes(query.toLowerCase()));
    renderAutocompleteDropdown(field);
  }

  function renderAutocompleteDropdown(field) {
    let dd = document.getElementById('autocompleteDropdown');
    if (!dd) { dd = document.createElement('div'); dd.id = 'autocompleteDropdown'; dd.className = 'autocomplete-dropdown'; document.body.appendChild(dd); }
    if (autoCompleteResults.length === 0) { dd.style.display = 'none'; return; }

    const rect = field.getBoundingClientRect();
    const text = field.value.substring(0, field.selectionStart);
    const beforeAt = text.substring(0, text.lastIndexOf('@'));
    const meas = document.createElement('span');
    meas.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-family:' + getComputedStyle(field).fontFamily + ';font-size:' + getComputedStyle(field).fontSize;
    meas.textContent = beforeAt; document.body.appendChild(meas);
    const xOff = meas.offsetWidth; document.body.removeChild(meas);
    const lineH = parseFloat(getComputedStyle(field).lineHeight) || 20;
    const lines = beforeAt.split('\n');

    dd.style.display = 'block';
    dd.style.left = (rect.left + xOff) + 'px';
    dd.style.top = (rect.top + (lines.length - 1) * lineH + lineH + 2) + 'px';
    dd.style.minWidth = '160px';
    dd.innerHTML = '';
    autoCompleteResults.forEach((id, i) => {
      const item = document.createElement('div');
      item.className = 'ac-item' + (i === autoCompleteIdx ? ' ac-selected' : '');
      item.textContent = id;
      item.addEventListener('mousedown', (e) => { e.preventDefault(); acceptAutocomplete(id); });
      item.addEventListener('mouseenter', () => { autoCompleteIdx = i; renderAutocompleteDropdown(field); });
      dd.appendChild(item);
    });
  }

  function acceptAutocomplete(id) {
    if (!autoCompleteField || !autoCompleteActive) return;
    const field = autoCompleteField;
    const val = field.value;
    const before = val.substring(0, autoCompleteTriggerPos);
    const after = val.substring(field.selectionStart);
    const afterAt = after.startsWith('@') ? after.substring(1) : after;
    const spaceIdx = afterAt.search(/[\s,;)\]]/);
    const trimmedAfter = spaceIdx >= 0 ? afterAt.substring(spaceIdx) : '';
    field.value = before + id + trimmedAfter;
    const newCursor = (before + id).length;
    field.setSelectionRange(newCursor, newCursor);
    closeAutocomplete();
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function closeAutocomplete() {
    autoCompleteActive = false; autoCompleteResults = []; autoCompleteField = null;
    const dd = document.getElementById('autocompleteDropdown');
    if (dd) dd.style.display = 'none';
  }

  function handleAutocompleteKeydown(e, field) {
    if (!autoCompleteActive) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); autoCompleteIdx = (autoCompleteIdx + 1) % autoCompleteResults.length; renderAutocompleteDropdown(field); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); autoCompleteIdx = (autoCompleteIdx - 1 + autoCompleteResults.length) % autoCompleteResults.length; renderAutocompleteDropdown(field); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { if (autoCompleteResults.length > 0) { e.preventDefault(); acceptAutocomplete(autoCompleteResults[autoCompleteIdx]); } return; }
    if (e.key === 'Escape') { e.preventDefault(); closeAutocomplete(); return; }
  }

  function handleAutocompleteInput(e) {
    const field = e.target;
    const val = field.value;
    const cursor = field.selectionStart;
    const beforeCursor = val.substring(0, cursor);
    const atIdx = beforeCursor.lastIndexOf('@');
    if (atIdx >= 0) {
      const afterAt = beforeCursor.substring(atIdx + 1);
      if (!afterAt.includes(' ') && !afterAt.includes('\n') && !afterAt.includes(',')) { showAutocomplete(field, atIdx); return; }
    }
    closeAutocomplete();
  }

  inputsField.addEventListener('input', handleAutocompleteInput);
  inputsField.addEventListener('keydown', (e) => handleAutocompleteKeydown(e, inputsField));
  fnEditor.addEventListener('input', handleAutocompleteInput);
  fnEditor.addEventListener('keydown', (e) => handleAutocompleteKeydown(e, fnEditor));

  document.addEventListener('mousedown', (e) => {
    const dd = document.getElementById('autocompleteDropdown');
    if (dd && dd.style.display !== 'none' && !dd.contains(e.target)) closeAutocomplete();
  });

  /* ---- API Helper ---- */

  function apiPost(action, payload) {
    return fetch(API_URL + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '' },
      body: JSON.stringify(payload),
    }).then(r => r.json());
  }

  /* ---- Persistence ---- */

  function serializeCanvas() {
    const funcs = [];
    const vars = [];
    const imms = [];
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].type === 'function') {
        funcs.push(nodes[i]);
      } else if (nodes[i].type === 'variable') {
        vars.push(nodes[i]);
      } else if (nodes[i].type === 'immutable') {
        imms.push(nodes[i]);
      }
    }
    return {
      functions: funcs.map(n => ({ dbId: n.dbId ?? null, fnName: n.fnName, fnCode: n.fnCode, fnInputs: n.fnInputs, fnOutputs: n.fnOutputs || '', fnSizeKB: n.fnSizeKB, fnOp: n.fnOp || '', fnEnd: !!n.fnEnd, x: n.x, y: n.y })),
      variables: vars.map(n => ({ dbId: n.dbId ?? null, label: n.label, x: n.x, y: n.y })),
      immutables: imms.map(n => ({ dbId: n.dbId ?? null, label: n.label, immValue: n.immValue, initialized: n.initialized, x: n.x, y: n.y })),
      edges: edges.map(e => {
        const fromNode = nodes.findIndex(n => n.id === e.fromNodeId);
        const toNode = nodes.findIndex(n => n.id === e.toNodeId);
        return {
          fromNodeId: fromNode >= 0 ? fromNode : null,
          fromPortId: e.fromPortId,
          toNodeId: toNode >= 0 ? toNode : null,
          toPortId: e.toPortId
        };
      }),
      settings: { ...projectSettings },
    };
  }

  let lastSaveFilename = '';

  function saveToDatabase() {
    const t = currentTab();
    if (!t) return;
    if (!currentProjectId) {
      apiPost('project_save', { name: programName })
        .then(data => { if (data.id) { currentProjectId = data.id; doSaveToDb(); } })
        .catch(() => { saveIndicator.textContent = 'DB save failed'; });
    } else {
      doSaveToDb();
    }
  }

  function doSaveToDb() {
    const cd = serializeCanvas();
    apiPost('canvas_save', {
      project_id: currentProjectId,
      name: programName,
      functions: cd.functions,
      variables: cd.variables,
      immutables: cd.immutables,
      edges: cd.edges,
      settings: cd.settings,
    }).then(data => {
      if (data.ok) {
        let fnIdx = 0, varIdx = 0, immIdx = 0;
        for (const n of nodes) {
          if (n.type === 'function' && data.fnIds && data.fnIds[fnIdx] !== undefined) n.dbId = data.fnIds[fnIdx++];
          else if (n.type === 'variable' && data.varIds && data.varIds[varIdx] !== undefined) n.dbId = data.varIds[varIdx++];
          else if (n.type === 'immutable' && data.immIds && data.immIds[immIdx] !== undefined) n.dbId = data.immIds[immIdx++];
        }
        isDirty = false; progDisplay.classList.remove('dirty');
        const t = currentTab(); if (t) t.isDirty = false;
        saveIndicator.textContent = 'Saved to DB';
        setTimeout(() => { saveIndicator.textContent = ''; }, 2000);
      } else {
        saveIndicator.textContent = 'DB save failed';
      }
    }).catch(() => { saveIndicator.textContent = 'DB save failed'; });
  }

  function saveToFile(forceNew) {
    if (forceNew) lastSaveFilename = '';
    if (!lastSaveFilename) {
      const name = prompt('Save .adg as:', programName);
      if (!name) return;
      programName = name;
      const t = currentTab(); if (t) t.name = name;
      lastSaveFilename = `${name.replace(/[^a-zA-Z0-9]/g, '_')}.adg`;
    }
    doFileDownload(lastSaveFilename);
  }

  function doFileDownload(filename) {
    const adg = generateAdgText();
    const blob = new Blob([adg], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    isDirty = false; progDisplay.classList.remove('dirty');
    const t = currentTab(); if (t) t.isDirty = false;
    progDisplay.textContent = programName;
    saveIndicator.textContent = `Saved ${filename}`;
    setTimeout(() => { saveIndicator.textContent = ''; }, 2000);
  }

  document.getElementById('navSave').addEventListener('click', () => saveToDatabase());
  document.getElementById('navDownloadAdg').addEventListener('click', () => saveToFile(true));

  /* ---- Rename ---- */

  progDisplay.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    document.getElementById('renameInput').value = programName;
    document.getElementById('renameModal').style.display = 'flex';
    document.getElementById('renameInput').focus(); document.getElementById('renameInput').select();
  });
  document.getElementById('renameModalCancel').addEventListener('click', () => { document.getElementById('renameModal').style.display = 'none'; });
  document.getElementById('renameModalConfirm').addEventListener('click', () => {
    const val = document.getElementById('renameInput').value.trim();
    if (val) {
      programName = val;
      progDisplay.textContent = val;
      const t = currentTab();
      if (t) { t.name = val; t.programName = val; renderTabBar(); }
      markDirty();
    }
    document.getElementById('renameModal').style.display = 'none';
  });
  document.getElementById('renameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('renameModalConfirm').click();
    if (e.key === 'Escape') document.getElementById('renameModalCancel').click();
  });

  /* ---- Project Switcher ---- */

  function isCanvasBlank() { return nodes.length === 0 && fnEditor.value.trim() === ''; }

  function showProjectSwitcher() {
    apiPost('project_list', {})
      .then(renderProjectDropdown).catch(() => {});
  }

  function renderProjectDropdown(projects) {
    const dd = document.getElementById('projectDropdown');
    const list = document.getElementById('projectList');
    const fullList = document.getElementById('projectListFull');
    const showAll = document.getElementById('showAllToggle');

    const recent = projects.slice(0, 5);
    const rest = projects.slice(5);

    list.innerHTML = '';
    recent.forEach(p => list.appendChild(_createProjectItem(p)));

    fullList.innerHTML = '';
    fullList.style.display = 'none';
    rest.forEach(p => fullList.appendChild(_createProjectItem(p)));

    showAll.textContent = 'Show all';
    showAll.style.display = rest.length > 0 ? 'block' : 'none';
    showAll.onclick = () => {
      if (fullList.style.display === 'block') { fullList.style.display = 'none'; showAll.textContent = 'Show all'; }
      else { fullList.style.display = 'block'; showAll.textContent = 'Show less'; }
    };

    const newBtn = document.createElement('div');
    newBtn.className = 'pd-new-btn';
    newBtn.innerHTML = '<i class="fa-solid fa-plus"></i> New Project';
    newBtn.onclick = () => {
      dd.style.display = 'none'; projectDropdownOpen = false;
      if (!isCanvasBlank() && currentProjectId && confirm('Save current project before creating a new one?')) saveProgram(false);
      resetToNewCanvas();
    };

    const existing = dd.querySelector('.pd-new-btn');
    if (existing) existing.remove();
    const sa = dd.querySelector('.pd-show-all');
    if (sa) sa.after(newBtn); else dd.appendChild(newBtn);

    dd.style.display = 'block';
    projectDropdownOpen = true;
  }

  function _createProjectItem(project) {
    const item = document.createElement('div');
    item.className = 'pd-item' + (project.id === currentProjectId ? ' pd-active' : '');
    const ns = document.createElement('span'); ns.className = 'pd-name'; ns.textContent = project.name;
    const ds = document.createElement('span'); ds.className = 'pd-date';
    const d = new Date(project.updated_at);
    const diffMs = Date.now() - d;
    if (diffMs < 60000) ds.textContent = 'now';
    else if (diffMs < 3600000) ds.textContent = Math.floor(diffMs / 60000) + 'm ago';
    else if (diffMs < 86400000) ds.textContent = Math.floor(diffMs / 3600000) + 'h ago';
    else if (diffMs < 604800000) ds.textContent = Math.floor(diffMs / 86400000) + 'd ago';
    else ds.textContent = d.toLocaleDateString();
    item.appendChild(ns); item.appendChild(ds);
    item.onclick = () => {
      document.getElementById('projectDropdown').style.display = 'none'; projectDropdownOpen = false;
      if (currentProjectId === project.id) return;
      const proceed = () => { window.location.href = '?id=' + project.id; };
      if (!isCanvasBlank()) {
        if (confirm('Save current project before switching?')) { if (currentProjectId) saveProgram(false); setTimeout(proceed, 300); } else proceed();
      } else proceed();
    };
    return item;
  }

  function resetToNewCanvas() {
    nodes.length = 0; edges.length = 0;
    currentProjectId = null; programName = 'Unsaved';
    fnNode = null; selectedNode = null;
    fnNameInput.value = 'handler'; inputsField.value = ''; fnEditor.value = '';
    sizeInput.value = 1; sizeInKB = 1; sizeBarFill.style.width = (1 / 1024 * 100) + '%'; sizeUnit.textContent = 'KB';
    outputBox.textContent = '// Compile to see output'; outputBox.classList.remove('has-output');
    progDisplay.textContent = 'Unsaved'; progDisplay.classList.remove('dirty');
    isDirty = false; saveIndicator.textContent = '';
    deselectNode(); render();
  }

  document.getElementById('projectSwitcherBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = document.getElementById('projectDropdown');
    if (projectDropdownOpen) { dd.style.display = 'none'; projectDropdownOpen = false; }
    else showProjectSwitcher();
  });

  document.addEventListener('mousedown', (e) => {
    const dd = document.getElementById('projectDropdown');
    const btn = document.getElementById('projectSwitcherBtn');
    if (projectDropdownOpen && dd && !dd.contains(e.target) && !btn.contains(e.target)) { dd.style.display = 'none'; projectDropdownOpen = false; }
  });

  /* ---- Load on startup ---- */

  function loadProject(projectId) {
    apiPost('project_load', { id: projectId })
      .then(data => {
        if (!data || data.error) {
          if (data?.error) console.error('loadProject error:', data.error);
          return;
        }

        currentProjectId = projectId;
        programName = data.project.name;
        progDisplay.textContent = programName;
        progDisplay.classList.remove('dirty');
        isDirty = false;

        if (data.project.settings) {
          const s = data.project.settings;
          projectSettings.memory = s.memory || 8192;
          projectSettings.immutable_pct = s.immutable_pct || 3;
          projectSettings.max_cycles = s.max_cycles || 1000;
        } else {
          projectSettings = { memory: 8192, immutable_pct: 3, max_cycles: 1000 };
        }
        syncSettingsToSidebar();

        nodes.length = 0;
        edges.length = 0;
        nodeIdCounter = 0;
        selectedNode = null;
        fnNode = null;

        for (const f of data.functions) {
          const fnName = f.fn_name || 'handler';
          const n = {
            id: ++nodeIdCounter,
            dbId: f.id,
            type: 'function',
            x: parseFloat(f.pos_x) || 0,
            y: parseFloat(f.pos_y) || 0,
            w: 180, h: 52,
            color: '#8b5cf6',
            fnName: fnName,
            fnCode: f.fn_code || '',
            fnInputs: f.fn_inputs || '',
            fnSizeKB: parseInt(f.fn_size_kb) || 1,
            fnOp: f.fn_op || '',
            fnEnd: !!f.fn_end,
            label: fnName
          };
          fitNodeWidth(n, fnName, 180, 50);
          nodes.push(n);
        }

        for (const v of data.variables) {
          const label = v.var_name || `var_${nodeIdCounter}`;
          const n = {
            id: ++nodeIdCounter,
            dbId: v.id,
            type: 'variable',
            x: parseFloat(v.pos_x) || 0,
            y: parseFloat(v.pos_y) || 0,
            w: 140, h: 52,
            color: '#3b82f6',
            label,
          };
          fitNodeWidth(n, label, 140, 40);
          nodes.push(n);
        }

        for (const v of data.immutables) {
          const immInitialized = !!v.initialized;
          const immVal = v.imm_value || null;
          const hasVal = immInitialized && immVal;
          const n = {
            id: ++nodeIdCounter,
            dbId: v.id,
            type: 'immutable',
            x: parseFloat(v.pos_x) || 0,
            y: parseFloat(v.pos_y) || 0,
            w: hasVal ? 160 : 130, h: 60,
            color: '#059669',
            label: v.imm_name || `imm_${nodeIdCounter}`,
            immValue: immVal,
            initialized: immInitialized,
          };
          nodes.push(n);
        }

        const firstFn = nodes.find(n => n.type === 'function');
        if (firstFn) {
          fnNode = firstFn;
          selectNode(firstFn);
          fnNameInput.value = firstFn.fnName;
          inputsField.value = firstFn.fnInputs;
          fnEditor.value = firstFn.fnCode;
          sizeInput.value = firstFn.fnSizeKB;
          sizeInKB = firstFn.fnSizeKB;
          sizeBarFill.style.width = (firstFn.fnSizeKB / 1024 * 100) + '%';
          sizeUnit.textContent = firstFn.fnSizeKB > 1024 ? 'MB' : 'KB';
        } else {
          fnNameInput.value = 'handler';
          inputsField.value = '';
          fnEditor.value = '';
          sizeInput.value = 1;
          sizeInKB = 1;
          sizeBarFill.style.width = (1 / 1024 * 100) + '%';
          sizeUnit.textContent = 'KB';
          document.getElementById('fnOpSelect').value = '';
          document.getElementById('fnEndToggle').checked = false;
          document.getElementById('opSection').style.display = 'none';
          document.getElementById('endSection').style.display = 'none';
          deselectNode();
        }

        outputBox.textContent = '// Compile to see output';
        outputBox.classList.remove('has-output');

        if (data.connections && data.connections.length > 0) {
          for (const c of data.connections) {
            const fromIdx = parseInt(c.from_node_idx);
            const toIdx = parseInt(c.to_node_idx);
            const fromNode = nodes[fromIdx];
            const toNode = nodes[toIdx];
            if (fromNode && toNode) {
              edges.push({ fromNodeId: fromNode.id, fromPortId: c.from_port_id, toNodeId: toNode.id, toPortId: c.to_port_id });
            }
          }
        }

        render();
      })
      .catch((err) => { console.error('loadProject fetch error:', err); });
  }

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('id')) loadProject(urlParams.get('id'));

  /* ---- roundRect polyfill ---- */

  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      this.moveTo(x + r, y);
      this.lineTo(x + w - r, y);
      this.quadraticCurveTo(x + w, y, x + w, y + r);
      this.lineTo(x + w, y + h - r);
      this.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      this.lineTo(x + r, y + h);
      this.quadraticCurveTo(x, y + h, x, y + h - r);
      this.lineTo(x, y + r);
      this.quadraticCurveTo(x, y, x + r, y);
      this.closePath();
    };
  }

})();