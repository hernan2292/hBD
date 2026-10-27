// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (s) => /** @type {HTMLElement} */ (document.querySelector(s));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));

  /** @type {any[]} */
  let tabs = [];
  let active = -1;
  let running = null;

  // @ts-ignore
  const grid = new window.HbdGrid($('#grid'), {
    editable: false,
    onAction: (name, p) => {
      const t = tabs[active];
      if (name === 'export') exportTab();
      else vscode.postMessage({ type: name, ...p, tableName: t && t.table });
    },
    onFocus: () => updateStatus()
  });

  function renderTabs() {
    const bar = $('#tabs');
    bar.innerHTML = tabs.map((t, i) => {
      const cls = ['tab', i === active ? 'active' : '', t.error ? 'err' : ''].join(' ');
      return `<div class="${cls}" data-i="${i}" title="${esc(t.sql || '')}">${t.pinned ? '📌 ' : ''}${esc(t.title)}<span class="x" data-x="${i}">✕</span></div>`;
    }).join('') + (running ? `<div class="tab"><span class="spinner"></span> Ejecutando…</div>` : '');
    $('#empty').classList.toggle('hidden', tabs.length > 0 || !!running);
  }

  function show(i) {
    active = i;
    const t = tabs[i];
    renderTabs();
    const isGrid = t && !t.error && t.columns && t.columns.length;
    $('#gridwrap').classList.toggle('hidden', !isGrid);
    $('#msg').classList.toggle('hidden', !!isGrid || !t);
    if (!t) { updateStatus(); return; }
    if (isGrid) {
      grid.setData(t.columns, t.rows);
      /** @type {HTMLInputElement} */ ($('#filter')).value = '';
    } else {
      const m = $('#msg');
      m.className = 'msg' + (t.error ? ' err' : '');
      m.textContent = t.error ? t.error : (t.message || 'Sentencia ejecutada correctamente.');
    }
    updateStatus();
    vscode.setState({ active });
  }

  function updateStatus() {
    const t = tabs[active];
    const st = $('#status');
    if (!t) { st.textContent = ''; return; }
    if (t.error) { st.textContent = 'Error'; st.className = 'status err'; return; }
    st.className = 'status';
    const parts = [];
    if (t.columns && t.columns.length) {
      const shown = grid.view.length;
      parts.push(`${t.rows.length}${t.truncated ? '+' : ''} filas`);
      if (shown !== t.rows.length) parts.push(`${shown} filtradas`);
      const s = grid.normSel();
      if (s && (s.r2 > s.r1 || s.c2 > s.c1)) parts.push(`sel ${s.r2 - s.r1 + 1}×${s.c2 - s.c1 + 1}`);
    }
    if (t.affected !== undefined && t.affected !== null) parts.push(`${t.affected} filas afectadas`);
    if (t.duration !== undefined) parts.push(`${t.duration} ms`);
    if (t.truncated) parts.push('(resultado truncado, ver hbd.maxRows)');
    st.textContent = parts.join(' · ');
  }

  function exportTab() {
    const t = tabs[active];
    if (!t || !t.columns) return;
    vscode.postMessage({ type: 'export', columns: t.columns.map((c) => c.name), rows: t.rows, title: t.title, tableName: t.table, sql: t.sql });
  }

  $('#tabs').addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const x = t.getAttribute('data-x');
    if (x !== null) {
      const i = Number(x);
      tabs.splice(i, 1);
      const next = active > i ? active - 1 : active === i ? Math.min(i, tabs.length - 1) : active;
      show(tabs.length ? next : -1);
      return;
    }
    const tab = t.closest('[data-i]');
    if (tab) show(Number(tab.getAttribute('data-i')));
  });
  $('#tabs').addEventListener('dblclick', (e) => {
    const tab = /** @type {HTMLElement} */ (e.target).closest('[data-i]');
    if (!tab) return;
    const t = tabs[Number(tab.getAttribute('data-i'))];
    t.pinned = !t.pinned;
    renderTabs();
  });
  $('#filter').addEventListener('input', (e) => { grid.setFilter(/** @type {HTMLInputElement} */ (e.target).value); updateStatus(); });
  $('#btnRecord').addEventListener('click', () => $('#btnRecord').classList.toggle('on', grid.toggleRecordMode()));
  $('#btnPanel').addEventListener('click', () => $('#btnPanel').classList.toggle('on', grid.toggleValuePanel()));
  $('#btnExport').addEventListener('click', exportTab);
  $('#btnPin').addEventListener('click', () => { const t = tabs[active]; if (t) { t.pinned = !t.pinned; renderTabs(); } });
  $('#btnSql').addEventListener('click', () => { const t = tabs[active]; if (t && t.sql) vscode.postMessage({ type: 'openSql', sql: t.sql }); });
  $('#btnCloseAll').addEventListener('click', () => { tabs = tabs.filter((t) => t.pinned); show(tabs.length ? 0 : -1); });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'running') {
      running = m.sql || true;
      if (m.reset) tabs = tabs.filter((t) => t.pinned);
      renderTabs();
    } else if (m.type === 'addTab') {
      tabs.push(m.tab);
      show(tabs.length - 1);
    } else if (m.type === 'done') {
      running = null;
      renderTabs();
    }
  });

  vscode.postMessage({ type: 'ready' });
  renderTabs();
})();
