<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="csrf-token" content="{{ csrf_token() }}">
  <title>Ampersand · Canvas</title>
  <link rel="stylesheet" href="{{ asset('styles.css') }}" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" integrity="sha512-DTOQO9RWCH3ppGqcWaEA1BIZOC6xxalwEsw9c2QQeAIftl+Vegovlnee1c9QX4TctnWMn13TZye+giMm8e2LwA==" crossorigin="anonymous" referrerpolicy="no-referrer" />
</head>
<body>
  <div id="canvas-container">
    <canvas id="canvas"></canvas>

    <div class="selection-ring" id="selectionRing"></div>
    <div class="resize-handle nw" id="resizeNW"></div>
    <div class="resize-handle ne" id="resizeNE"></div>
    <div class="resize-handle sw" id="resizeSW"></div>
    <div class="resize-handle se" id="resizeSE"></div>

    <div id="topNav">
      <div class="nav-left">
        <div class="nav-project-btn" id="projectSwitcherBtn" title="Open project">
          <i class="fa-solid fa-folder-open"></i>
        </div>
        <div id="projectDropdown" class="project-dropdown" style="display:none">
          <div class="pd-header">Recent Projects</div>
          <div id="projectList"></div>
          <div id="projectListFull" style="display:none"></div>
          <div class="pd-show-all" id="showAllToggle">Show all</div>
        </div>
        <div class="nav-search">
          <i class="fa-solid fa-search"></i>
          <input type="text" id="searchInput" placeholder="Search canvas... (Ctrl+F)" spellcheck="false" />
        </div>
      </div>
      <div class="nav-center">
        <span id="programNameDisplay" title="Right-click to rename">Unsaved</span>
      </div>
      <div class="nav-right">
        <button id="navCompile" title="Compile (Ctrl+Enter)">
          <i class="fa-solid fa-hammer"></i>
        </button>
        <div class="nav-sep"></div>
        <button id="navLoadAdg" title="Load .adg into new tab">
          <i class="fa-solid fa-folder-open"></i>
        </button>
        <div class="nav-sep"></div>
        <button id="navSave" title="Save to file (click) / DB (Ctrl+S) / new file (Ctrl+Shift+S)">
          <i class="fa-solid fa-floppy-disk"></i>
        </button>
        <button id="navNewTab" title="New graph tab">
          <i class="fa-solid fa-plus"></i>
        </button>
      </div>
    </div>

    <div id="tabBar" class="tab-bar">
      <div id="tabList" class="tab-list"></div>
    </div>

    <div class="toolbar" id="toolbar">
      <button id="btnZoomIn" title="Zoom In (Ctrl+=)">
        <i class="fa-solid fa-magnifying-glass-plus"></i>
      </button>
      <button id="btnZoomOut" title="Zoom Out (Ctrl+-)">
        <i class="fa-solid fa-magnifying-glass-minus"></i>
      </button>
      <button id="btnReset" title="Reset View">
        <i class="fa-solid fa-rotate-left"></i>
      </button>
      <div class="sep"></div>
      <span class="info" id="infoDisplay">Z: 100% &middot; 0 shapes</span>
      <div class="sep"></div>
      <button id="btnAddVariable" title="Drag to canvas to create a variable" draggable="true">
        <i class="fa-solid fa-cube"></i>
        <span>Var</span>
      </button>
      <button id="btnAddImmutable" title="Drag to canvas to create an immutable" draggable="true">
        <i class="fa-solid fa-lock"></i>
        <span>Imm</span>
      </button>
      <div class="sep"></div>
      <button id="btnMoveToggle" title="Movement: WASD &amp; Arrow keys" class="active">
        <i class="fa-solid fa-arrows"></i>
        <span id="moveLabel">WASD + Arrows</span>
      </button>
    </div>
  </div>

  <div id="sidebar">
    <div class="sidebar-header">
      <i class="fa-solid fa-code"></i>
      <span>Functions</span>
      <span style="margin-left:auto;font-size:12px;color:#666688;font-weight:400" id="saveIndicator"></span>
    </div>

    <div class="sidebar-section" id="inputsSection">
      <label class="section-label">
        <i class="fa-solid fa-list"></i>
        Inputs
      </label>
      <input type="text" id="inputsField" class="modal-input" placeholder="var1, var2, var3" spellcheck="false" />
    </div>

    <div class="sidebar-section" id="sizeSection">
      <label class="section-label">
        <i class="fa-regular fa-hard-drive"></i>
        Max Input Size
      </label>
      <div class="size-input-row">
        <input type="number" id="sizeValue" value="1" min="1" max="1024" />
        <span class="size-unit" id="sizeUnit">KB</span>
      </div>
      <div class="size-bar" id="sizeBar">
        <div class="size-bar-fill" id="sizeBarFill"></div>
      </div>
    </div>

    <div class="sidebar-section" id="fnNameSection">
      <label class="section-label">
        <i class="fa-solid fa-signature"></i>
        Function Name
      </label>
      <input type="text" id="fnNameInput" class="modal-input" placeholder="handler" spellcheck="false" value="handler" />
    </div>

    <div class="sidebar-section" id="opSection">
      <label class="section-label">
        <i class="fa-solid fa-bolt"></i>
        Operation
      </label>
      <div style="display:flex;gap:8px;align-items:center">
        <select id="fnOpSelect" class="modal-input" style="flex:1">
          <option value="">auto (from name)</option>
          <option value="add">add (+)</option>
          <option value="sub">sub (-)</option>
          <option value="mul">mul (*)</option>
          <option value="div">div (/)</option>
          <option value="mod">mod (%)</option>
          <option value="lt">lt (&lt;)</option>
          <option value="gt">gt (&gt;)</option>
          <option value="eq">eq (==)</option>
          <option value="neq">neq (!=)</option>
          <option value="mux">mux (select)</option>
          <option value="load">load (read)</option>
          <option value="store">store (write)</option>
          <option value="pass">pass (identity)</option>
        </select>
      </div>
    </div>

    <div class="sidebar-section" id="endSection" style="display:flex;justify-content:space-between;align-items:center;">
      <label class="section-label" style="margin-bottom:0;gap:8px;">
        <i class="fa-solid fa-flag-checkered"></i>
        End Node (termination)
      </label>
      <label class="imm-toggle" style="flex-shrink:0">
        <input type="checkbox" id="fnEndToggle" />
        <span class="imm-toggle-slider"></span>
      </label>
    </div>

    <div class="sidebar-section sidebar-editor-section" id="editorSection">
      <label class="section-label">
        <i class="fa-solid fa-terminal"></i>
        Code
      </label>
      <textarea id="fnEditor" placeholder="// Shift+C to focus&#10;function handler(req) {&#10;  return { ok: true };&#10;}" spellcheck="false"></textarea>
    </div>

    <div class="sidebar-section" id="outputSection">
      <label class="section-label">
        <i class="fa-regular fa-rectangle-list"></i>
        Output
      </label>
      <div id="outputBox" class="output-box">// Compile to see output</div>
    </div>

    <div class="sidebar-footer">
      <button id="btnCreateFn">
        <i class="fa-solid fa-plus"></i>
        Add to Graph
      </button>
    </div>
  </div>

  <div id="varModal" class="modal-overlay" style="display:none">
    <div class="modal-box">
      <div class="modal-header">
        <i class="fa-solid fa-cube"></i>
        <span id="varModalTitle">New Variable</span>
      </div>
      <div class="modal-body">
        <label class="modal-label">Identifier</label>
        <input type="text" id="varNameInput" class="modal-input" placeholder="myVariable" spellcheck="false" />
      </div>
      <div class="modal-footer">
        <button id="varModalCancel" class="modal-btn modal-btn-secondary">Cancel</button>
        <button id="varModalConfirm" class="modal-btn modal-btn-primary">Create</button>
      </div>
    </div>
  </div>

  <div id="immModal" class="modal-overlay" style="display:none">
    <div class="modal-box">
      <div class="modal-header">
        <i class="fa-solid fa-lock"></i>
        <span id="immModalTitle">New Immutable</span>
      </div>
      <div class="modal-body">
        <label class="modal-label">Identifier</label>
        <input type="text" id="immNameInput" class="modal-input" placeholder="myConstant" spellcheck="false" />
        <div style="height:14px"></div>
        <label class="modal-label">Value</label>
        <input type="text" id="immValueInput" class="modal-input" placeholder="Enter value to initialize" spellcheck="false" />
        <div style="height:14px"></div>
        <div class="imm-switch-row">
          <span class="imm-switch-label">Initialized</span>
          <label class="imm-toggle">
            <input type="checkbox" id="immInitialized" disabled />
            <span class="imm-toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="modal-footer">
        <button id="immModalCancel" class="modal-btn modal-btn-secondary">Cancel</button>
        <button id="immModalConfirm" class="modal-btn modal-btn-primary">Create</button>
      </div>
    </div>
  </div>

  <div id="nodeTooltip" class="node-tooltip" style="display:none"></div>

  <input type="file" id="adgFileInput" accept=".adg" style="display:none" />

  <div id="renameModal" class="modal-overlay" style="display:none">
    <div class="modal-box">
      <div class="modal-header">
        <i class="fa-solid fa-pen"></i>
        <span>Rename Project</span>
      </div>
      <div class="modal-body">
        <label class="modal-label">Project Name</label>
        <input type="text" id="renameInput" class="modal-input" placeholder="My Project" spellcheck="false" />
      </div>
      <div class="modal-footer">
        <button id="renameModalCancel" class="modal-btn modal-btn-secondary">Cancel</button>
        <button id="renameModalConfirm" class="modal-btn modal-btn-primary">Rename</button>
      </div>
    </div>
  </div>

  <script>
    const API_URL = '{{ url("api/canvas") }}';
    let currentProjectId = @json($projectId ?? null);
  </script>
  <script src="{{ asset('canvas.js') }}"></script>
</body>
</html>
