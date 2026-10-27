// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  const NS = 'http://www.w3.org/2000/svg';
  const W = 230, HEAD = 26, LINE = 18, MAXCOLS = 30;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));

  let tables = [];
  let pos = new Map();
  let zoom = 1, panX = 20, panY = 20;
  let keysOnly = false;
  let highlight = '';

  const canvas = $('canvas');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrowhead"/></marker></defs><g id="root"><g id="links"></g><g id="nodes"></g></g>`;
  canvas.appendChild(svg);
  const root = /** @type {SVGGElement} */ (svg.querySelector('#root'));
  const linksG = /** @type {SVGGElement} */ (svg.querySelector('#links'));
  const nodesG = /** @type {SVGGElement} */ (svg.querySelector('#nodes'));

  const style = document.createElement('style');
  style.textContent = `
    .tbl rect.box { fill: var(--vscode-editorWidget-background, #252526); stroke: var(--vscode-panel-border, #555); stroke-width: 1; }
    .tbl rect.head { fill: var(--vscode-button-background, #0e639c); }
    .tbl.hl rect.box { stroke: var(--vscode-focusBorder, #007fd4); stroke-width: 2.5; }
    .tbl text { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; fill: var(--vscode-foreground, #ccc); }
    .tbl text.title { fill: var(--vscode-button-foreground, #fff); font-weight: 600; font-family: var(--vscode-font-family, sans-serif); }
    .tbl text.type { fill: var(--vscode-descriptionForeground, #999); font-size: 11px; }
    .tbl text.pk { fill: var(--vscode-charts-yellow, #e5c07b); font-weight: 600; }
    .tbl text.fk { fill: var(--vscode-charts-blue, #61afef); }
    .tbl { cursor: move; }
    path.link { fill: none; stroke: var(--vscode-charts-blue, #61afef); stroke-width: 1.4; opacity: 0.8; }
    path.link.hl { stroke: var(--vscode-charts-orange, #d19a66); stroke-width: 2.4; opacity: 1; }
    .arrowhead { fill: var(--vscode-charts-blue, #61afef); }
    label.chk { display: flex; align-items: center; gap: 4px; color: var(--vscode-descriptionForeground); }`;
  document.head.appendChild(style);

  const visibleCols = (t) => {
    const cols = keysOnly ? t.columns.filter((c) => c.pk || c.fk) : t.columns;
    return cols.slice(0, MAXCOLS);
  };
  const height = (t) => {
    const n = visibleCols(t).length;
    const extra = (keysOnly ? t.columns.filter((c) => c.pk || c.fk).length : t.columns.length) > MAXCOLS ? 1 : 0;
    return HEAD + (n + extra) * LINE + 8;
  };

  function layout() {
    // orden por conectividad (BFS desde las tablas más relacionadas)
    const deg = new Map(tables.map((t) => [t.name, 0]));
    const adj = new Map(tables.map((t) => [t.name, new Set()]));
    for (const t of tables) for (const f of t.fks) {
      if (!adj.has(f.refTable)) continue;
      deg.set(t.name, (deg.get(t.name) || 0) + 1);
      deg.set(f.refTable, (deg.get(f.refTable) || 0) + 1);
      adj.get(t.name).add(f.refTable);
      adj.get(f.refTable).add(t.name);
    }
    const sorted = [...tables].sort((a, b) => (deg.get(b.name) || 0) - (deg.get(a.name) || 0));
    const order = [];
    const seen = new Set();
    for (const s of sorted) {
      if (seen.has(s.name)) continue;
      const q = [s.name];
      seen.add(s.name);
      while (q.length) {
        const n = q.shift();
        order.push(n);
        for (const m of adj.get(n) || []) if (!seen.has(m)) { seen.add(m); q.push(m); }
      }
    }
    const byName = new Map(tables.map((t) => [t.name, t]));
    const perRow = Math.max(1, Math.ceil(Math.sqrt(order.length * 1.6)));
    let x = 0, y = 0, rowH = 0, i = 0;
    pos = new Map();
    for (const name of order) {
      const t = byName.get(name);
      pos.set(name, { x, y });
      rowH = Math.max(rowH, height(t));
      i++;
      if (i % perRow === 0) { x = 0; y += rowH + 70; rowH = 0; } else x += W + 90;
    }
  }

  function render() {
    nodesG.innerHTML = '';
    for (const t of tables) {
      const p = pos.get(t.name);
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'tbl' + (highlight && t.name.toLowerCase().includes(highlight) ? ' hl' : ''));
      g.setAttribute('transform', `translate(${p.x},${p.y})`);
      g.dataset.name = t.name;
      const cols = visibleCols(t);
      const h = height(t);
      let html = `<rect class="box" width="${W}" height="${h}" rx="4"/><rect class="head" width="${W}" height="${HEAD}" rx="4"/><rect class="head" y="${HEAD - 5}" width="${W}" height="5"/>`;
      html += `<text class="title" x="8" y="17">${esc(t.name.length > 28 ? t.name.slice(0, 27) + '…' : t.name)}</text>`;
      cols.forEach((c, i) => {
        const y = HEAD + 15 + i * LINE;
        const icon = c.pk ? '🔑 ' : c.fk ? '↗ ' : '';
        const name = c.name.length > 18 ? c.name.slice(0, 17) + '…' : c.name;
        html += `<text x="8" y="${y}" class="${c.pk ? 'pk' : c.fk ? 'fk' : ''}">${icon}${esc(name)}${c.nullable ? '' : ' *'}</text>`;
        const type = String(c.type || '');
        html += `<text x="${W - 8}" y="${y}" class="type" text-anchor="end">${esc(type.length > 16 ? type.slice(0, 15) + '…' : type)}</text>`;
      });
      const total = keysOnly ? t.columns.filter((c) => c.pk || c.fk).length : t.columns.length;
      if (total > MAXCOLS) html += `<text x="8" y="${HEAD + 15 + cols.length * LINE}" class="type">… ${total - MAXCOLS} columnas más</text>`;
      const title = document.createElementNS(NS, 'title');
      title.textContent = `${t.schema ? t.schema + '.' : ''}${t.name}\n${t.columns.length} columnas\nDoble clic para abrir los datos`;
      g.innerHTML = html;
      g.appendChild(title);
      nodesG.appendChild(g);
    }
    renderLinks();
    applyTransform();
  }

  function colY(t, colName) {
    const cols = visibleCols(t);
    const i = cols.findIndex((c) => c.name === colName);
    return i < 0 ? HEAD / 2 : HEAD + 10 + i * LINE;
  }

  function renderLinks() {
    const byName = new Map(tables.map((t) => [t.name, t]));
    let html = '';
    for (const t of tables) {
      for (const f of t.fks) {
        const r = byName.get(f.refTable);
        if (!r) continue;
        const a = pos.get(t.name), b = pos.get(r.name);
        const y1 = a.y + colY(t, f.columns[0]);
        const y2 = b.y + colY(r, f.refColumns[0]);
        let x1, x2, c1, c2;
        if (t === r) {
          x1 = a.x + W; x2 = a.x + W;
          html += `<path class="link${hl(t, r)}" marker-end="url(#arrow)" d="M${x1},${y1} C${x1 + 50},${y1} ${x2 + 50},${y2} ${x2},${y2}"><title>${esc(f.name)}</title></path>`;
          continue;
        }
        if (a.x + W < b.x) { x1 = a.x + W; x2 = b.x; c1 = x1 + 40; c2 = x2 - 40; }
        else if (b.x + W < a.x) { x1 = a.x; x2 = b.x + W; c1 = x1 - 40; c2 = x2 + 40; }
        else { x1 = a.x + W; x2 = b.x + W; c1 = Math.max(x1, x2) + 50; c2 = c1; }
        html += `<path class="link${hl(t, r)}" marker-end="url(#arrow)" d="M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}"><title>${esc(f.name)}: ${esc(t.name)}(${esc(f.columns.join(', '))}) → ${esc(r.name)}(${esc(f.refColumns.join(', '))})</title></path>`;
      }
    }
    linksG.innerHTML = html;
  }

  function hl(t, r) {
    return highlight && (t.name.toLowerCase().includes(highlight) || r.name.toLowerCase().includes(highlight)) ? ' hl' : '';
  }

  function applyTransform() {
    root.setAttribute('transform', `translate(${panX},${panY}) scale(${zoom})`);
  }

  function bounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of tables) {
      const p = pos.get(t.name);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + W); maxY = Math.max(maxY, p.y + height(t));
    }
    return { minX, minY, maxX, maxY };
  }

  function fit() {
    if (!tables.length) return;
    const b = bounds();
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    zoom = Math.min(1.5, Math.max(0.1, Math.min((cw - 40) / (b.maxX - b.minX), (ch - 40) / (b.maxY - b.minY))));
    panX = 20 - b.minX * zoom;
    panY = 20 - b.minY * zoom;
    applyTransform();
  }

  function zoomAt(f, cx, cy) {
    const nz = Math.min(3, Math.max(0.08, zoom * f));
    panX = cx - (cx - panX) * (nz / zoom);
    panY = cy - (cy - panY) * (nz / zoom);
    zoom = nz;
    applyTransform();
  }

  // interacción
  let drag = null;
  svg.addEventListener('mousedown', (e) => {
    const g = /** @type {any} */ (e.target).closest('g.tbl');
    if (g) {
      const p = pos.get(g.dataset.name);
      drag = { kind: 'node', name: g.dataset.name, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, el: g };
    } else {
      drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: panX, oy: panY };
      canvas.style.cursor = 'grabbing';
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    if (drag.kind === 'node') {
      const p = pos.get(drag.name);
      p.x = drag.ox + (e.clientX - drag.sx) / zoom;
      p.y = drag.oy + (e.clientY - drag.sy) / zoom;
      drag.el.setAttribute('transform', `translate(${p.x},${p.y})`);
      renderLinks();
    } else {
      panX = drag.ox + e.clientX - drag.sx;
      panY = drag.oy + e.clientY - drag.sy;
      applyTransform();
    }
  });
  window.addEventListener('mouseup', () => { drag = null; canvas.style.cursor = 'grab'; });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  svg.addEventListener('dblclick', (e) => {
    const g = /** @type {any} */ (e.target).closest('g.tbl');
    if (g) vscode.postMessage({ type: 'openTable', name: g.dataset.name });
  });

  $('fit').addEventListener('click', fit);
  $('zin').addEventListener('click', () => zoomAt(1.2, canvas.clientWidth / 2, canvas.clientHeight / 2));
  $('zout').addEventListener('click', () => zoomAt(1 / 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2));
  $('relayout').addEventListener('click', () => { layout(); render(); fit(); });
  $('keysOnly').addEventListener('change', () => { keysOnly = $('keysOnly').checked; render(); });
  $('search').addEventListener('input', () => {
    highlight = $('search').value.toLowerCase();
    render();
    const t = highlight && tables.find((x) => x.name.toLowerCase().includes(highlight));
    if (t) {
      const p = pos.get(t.name);
      panX = canvas.clientWidth / 2 - (p.x + W / 2) * zoom;
      panY = canvas.clientHeight / 2 - (p.y + 60) * zoom;
      applyTransform();
    }
  });
  $('exportSvg').addEventListener('click', () => {
    const b = bounds();
    const clone = /** @type {SVGSVGElement} */ (svg.cloneNode(true));
    const pad = 20;
    clone.setAttribute('xmlns', NS);
    clone.setAttribute('width', String(b.maxX - b.minX + pad * 2 + 60));
    clone.setAttribute('height', String(b.maxY - b.minY + pad * 2));
    const r = /** @type {SVGGElement} */ (clone.querySelector('#root'));
    r.setAttribute('transform', `translate(${pad - b.minX},${pad - b.minY})`);
    // resolver variables CSS del tema para que el SVG sea autónomo
    const cs = getComputedStyle(document.body);
    const css = style.textContent.replace(/var\((--[\w-]+),\s*([^)]+)\)/g, (_, v, fb) => (cs.getPropertyValue(v).trim() || fb));
    const st = document.createElementNS(NS, 'style');
    st.textContent = css + ` svg { background: ${cs.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e'}; }`;
    clone.insertBefore(st, clone.firstChild);
    vscode.postMessage({ type: 'saveSvg', svg: '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone) });
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'data') {
      tables = m.tables;
      const rels = tables.reduce((a, t) => a + t.fks.length, 0);
      $('status').textContent = `${m.title} — ${tables.length} tablas, ${rels} relaciones${m.truncated ? ' (limitado a las primeras 200 tablas)' : ''}`;
      if (m.focus) { highlight = String(m.focus).toLowerCase(); $('search').value = m.focus; }
      layout();
      render();
      fit();
    } else if (m.type === 'error') {
      $('status').textContent = 'Error: ' + m.text;
      $('status').className = 'status err';
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
