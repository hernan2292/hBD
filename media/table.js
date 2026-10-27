// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (s) => /** @type {any} */ (document.querySelector(s));
  let editable = false;
  let state = { page: 0, pageSize: 200, hasMore: false, total: null, duration: 0, rows: 0 };
  let ddlText = '';
  let noKey = false;

  // @ts-ignore
  const grid = new window.HbdGrid($('#grid'), {
    editable: false,
    serverSort: true,
    tableMode: true,
    onSort: (sort) => {
      if (!guard()) return;
      vscode.postMessage({ type: 'load', sort: sort ? { column: grid.columns[sort.col].name, dir: sort.dir } : null });
    },
    onChange: (n) => updateEditButtons(n),
    onAction: (name, p) => {
      if (name === 'export') vscode.postMessage({ type: 'export' });
      else if (name === 'filter' || name === 'filterClear') { if (guard()) vscode.postMessage({ type: name, ...p }); }
      else vscode.postMessage({ type: name, ...p });
    },
    onFocus: () => updateStatus()
  });

  function showTab(tab) {
    document.querySelectorAll('#mainTabs .tab').forEach((t) => t.classList.toggle('active', t.getAttribute('data-tab') === tab));
    for (const t of ['data', 'props', 'ddl']) $('#tab-' + t).classList.toggle('hidden', t !== tab);
  }

  function guard() {
    if (grid.changeCount() > 0) {
      setStatus('Hay cambios sin guardar: guarde o descarte antes de recargar.', true);
      return false;
    }
    return true;
  }

  function load(extra) {
    if (!guard()) return;
    vscode.postMessage({ type: 'load', where: $('#where').value, orderBy: $('#orderBy').value, page: state.page, pageSize: state.pageSize, ...(extra || {}) });
  }

  function setStatus(text, err) {
    const s = $('#status');
    s.textContent = text;
    s.className = 'status' + (err ? ' err' : '');
  }

  function updateStatus() {
    const n = grid.changeCount();
    const parts = [`${state.rows} filas`, `${state.duration} ms`];
    if (state.total !== null) parts.push(`total: ${state.total}`);
    if (n) parts.push(`${n} cambio(s) sin guardar`);
    if (editable && noKey) parts.push('⚠ sin clave primaria: se usan todas las columnas para identificar filas');
    setStatus(parts.join(' · '), false);
  }

  function updateEditButtons(n) {
    $('#save').disabled = !n;
    $('#revert').disabled = !n;
    $('#preview').disabled = !n;
    updateStatus();
  }

  function updatePager() {
    const from = state.page * state.pageSize + 1;
    const to = state.page * state.pageSize + state.rows;
    $('#pageInfo').textContent = state.rows ? `${from}–${to}${state.total !== null ? ' de ' + state.total : ''}` : 'sin filas';
    $('#prev').disabled = state.page === 0;
    $('#first').disabled = state.page === 0;
    $('#next').disabled = !state.hasMore;
  }

  document.querySelectorAll('#mainTabs .tab').forEach((t) => t.addEventListener('click', () => showTab(t.getAttribute('data-tab'))));
  $('#apply').addEventListener('click', () => { state.page = 0; load(); });
  $('#reload').addEventListener('click', () => load());
  $('#where').addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.page = 0; load(); } });
  $('#orderBy').addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.page = 0; load(); } });
  $('#first').addEventListener('click', () => { state.page = 0; load(); });
  $('#prev').addEventListener('click', () => { state.page = Math.max(0, state.page - 1); load(); });
  $('#next').addEventListener('click', () => { state.page++; load(); });
  $('#pageSize').addEventListener('change', () => { state.pageSize = Number($('#pageSize').value); state.page = 0; load(); });
  $('#count').addEventListener('click', () => vscode.postMessage({ type: 'count' }));
  $('#addRow').addEventListener('click', () => grid.addRow());
  $('#dupRow').addEventListener('click', () => grid.duplicateRows());
  $('#delRow').addEventListener('click', () => grid.deleteRows());
  $('#save').addEventListener('click', save);
  $('#revert').addEventListener('click', () => grid.revert());
  $('#preview').addEventListener('click', () => vscode.postMessage({ type: 'preview', changes: grid.getChanges() }));
  $('#btnRecord').addEventListener('click', () => $('#btnRecord').classList.toggle('on', grid.toggleRecordMode()));
  $('#btnPanel').addEventListener('click', () => $('#btnPanel').classList.toggle('on', grid.toggleValuePanel()));
  $('#export').addEventListener('click', () => vscode.postMessage({ type: 'export' }));
  $('#openSql').addEventListener('click', () => vscode.postMessage({ type: 'openQuery' }));
  $('#quick').addEventListener('input', () => grid.setFilter($('#quick').value));
  $('#ddlOpen').addEventListener('click', () => vscode.postMessage({ type: 'ddlOpen', text: ddlText }));
  $('#ddlCopy').addEventListener('click', () => vscode.postMessage({ type: 'copyText', text: ddlText }));
  $('#ddlRefresh').addEventListener('click', () => vscode.postMessage({ type: 'ddlRefresh' }));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
    else if (e.key === 'F5') { e.preventDefault(); load(); }
  });

  function save() {
    if (!editable || grid.changeCount() === 0) return;
    setStatus('Guardando…');
    vscode.postMessage({ type: 'save', changes: grid.getChanges() });
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'init':
        editable = m.editable;
        grid.opts.editable = editable;
        $('#editTools').classList.toggle('hidden', !editable);
        $('#title').textContent = m.title;
        state.pageSize = m.pageSize;
        $('#pageSize').value = String(m.pageSize);
        if (!$('#pageSize').value) {
          const o = document.createElement('option');
          o.textContent = String(m.pageSize);
          $('#pageSize').appendChild(o);
          $('#pageSize').value = String(m.pageSize);
        }
        showTab(m.tab || 'data');
        break;
      case 'tab':
        showTab(m.tab);
        break;
      case 'loading':
        setStatus('Cargando…');
        break;
      case 'data': {
        noKey = m.noKey;
        state = { ...state, page: m.page, pageSize: m.pageSize, hasMore: m.hasMore, duration: m.duration, rows: m.rows.length };
        $('#where').value = m.where;
        $('#orderBy').value = m.orderBy;
        const sortCol = (() => {
          const ob = (m.orderBy || '').trim();
          const mm = /^["`\[]?([^"`\]\s]+)["`\]]?\s*(asc|desc)?$/i.exec(ob);
          if (!mm) return null;
          const idx = m.columns.findIndex((c) => c.name === mm[1]);
          return idx >= 0 ? { col: idx, dir: (mm[2] || 'asc').toLowerCase() } : null;
        })();
        grid.setData(m.columns, m.rows, { rowOffset: m.page * m.pageSize, sort: sortCol, keyIdx: m.keyIdx });
        $('#quick').value = '';
        updatePager();
        updateEditButtons(0);
        break;
      }
      case 'count':
        state.total = m.total;
        updatePager();
        updateStatus();
        break;
      case 'error':
        setStatus(m.text, true);
        break;
      case 'props':
        $('#props').innerHTML = m.html;
        $('#props').className = '';
        break;
      case 'ddl':
        ddlText = m.text;
        $('#ddl').textContent = m.text;
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
