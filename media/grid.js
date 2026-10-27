// @ts-check
/* Grilla de datos virtualizada compartida por el panel de resultados y el editor de tablas. */
(function () {
  const ROW_H = 22;
  const MAX_CELL = 400;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
  const same = (a, b) => (a === null || b === null) ? a === b : String(a) === String(b);

  class Grid {
    /**
     * @param {HTMLElement} host
     * @param {{editable?: boolean, serverSort?: boolean, onSort?: Function, onChange?: Function, onAction?: Function, onFocus?: Function, tableMode?: boolean}} opts
     */
    constructor(host, opts) {
      this.host = host;
      this.opts = opts || {};
      this.columns = [];
      this.rows = [];
      this.view = [];
      this.sort = null;
      this.filter = '';
      this.sel = null;
      this.widths = [];
      this.rowOffset = 0;
      this.recordMode = false;
      this.panelOpen = false;
      this.editor = null;
      host.classList.add('grid-host');
      host.innerHTML = `
        <div class="grid-main">
          <div class="grid-scroll" tabindex="0">
            <table class="grid"><colgroup></colgroup><thead></thead><tbody></tbody></table>
            <div class="grid-empty hidden">Sin filas</div>
          </div>
          <div class="record hidden"></div>
        </div>
        <div class="valpanel hidden">
          <div class="vp-head"><span class="vp-title"></span><button class="vp-close" title="Cerrar">✕</button></div>
          <textarea class="vp-text" spellcheck="false"></textarea>
          <div class="vp-actions">
            <button class="vp-json">Formatear JSON</button>
            <button class="vp-null">NULL</button>
            <button class="vp-open">Abrir en editor</button>
            <button class="vp-apply primary">Aplicar</button>
          </div>
        </div>
        <div class="ctxmenu hidden"></div>`;
      this.scroll = /** @type {HTMLElement} */ (host.querySelector('.grid-scroll'));
      this.table = /** @type {HTMLTableElement} */ (host.querySelector('table.grid'));
      this.colgroup = /** @type {HTMLElement} */ (host.querySelector('colgroup'));
      this.thead = /** @type {HTMLElement} */ (host.querySelector('thead'));
      this.tbody = /** @type {HTMLElement} */ (host.querySelector('tbody'));
      this.empty = /** @type {HTMLElement} */ (host.querySelector('.grid-empty'));
      this.record = /** @type {HTMLElement} */ (host.querySelector('.record'));
      this.panel = /** @type {HTMLElement} */ (host.querySelector('.valpanel'));
      this.menu = /** @type {HTMLElement} */ (host.querySelector('.ctxmenu'));
      this.bind();
    }

    // ---------------------------------------------------------------- datos
    setData(columns, rows, extra) {
      extra = extra || {};
      this.cancelEdit();
      this.columns = columns || [];
      this.rows = (rows || []).map((v) => ({ orig: v, values: v.slice(), state: null, changed: new Set() }));
      this.rowOffset = extra.rowOffset || 0;
      if (extra.sort !== undefined) this.sort = extra.sort;
      else if (!this.opts.serverSort) this.sort = null;
      this.keyIdx = extra.keyIdx || [];
      this.computeWidths();
      this.applyView();
      this.sel = this.view.length ? { r1: 0, c1: 0, r2: 0, c2: 0 } : null;
      this.scroll.scrollTop = 0;
      this.scroll.scrollLeft = 0;
      this.renderAll();
      this.fireFocus();
    }

    computeWidths() {
      this.widths = this.columns.map((c, i) => {
        let len = Math.max(c.name.length + 2, (c.type || '').length * 0.8);
        const n = Math.min(this.rows.length, 60);
        for (let r = 0; r < n; r++) {
          const v = this.rows[r].values[i];
          len = Math.max(len, v === null ? 6 : Math.min(60, String(v).length));
        }
        return Math.round(Math.min(380, Math.max(60, len * 7.2 + 22)));
      });
    }

    setFilter(text) {
      this.filter = (text || '').toLowerCase();
      this.applyView();
      this.sel = this.view.length ? { r1: 0, c1: 0, r2: 0, c2: 0 } : null;
      this.renderAll();
    }

    applyView() {
      const f = this.filter;
      let idx = [];
      for (let i = 0; i < this.rows.length; i++) {
        if (!f || this.rows[i].values.some((v) => v !== null && String(v).toLowerCase().includes(f))) idx.push(i);
      }
      if (this.sort && !this.opts.serverSort) {
        const { col, dir } = this.sort;
        const m = dir === 'desc' ? -1 : 1;
        idx.sort((a, b) => {
          const x = this.rows[a].values[col], y = this.rows[b].values[col];
          if (x === y) return 0;
          if (x === null) return -1 * m;
          if (y === null) return 1 * m;
          if (typeof x === 'number' && typeof y === 'number') return (x - y) * m;
          return String(x).localeCompare(String(y), undefined, { numeric: true }) * m;
        });
      }
      this.view = idx;
    }

    // ---------------------------------------------------------------- render
    renderAll() {
      this.renderHead();
      this.renderBody();
      this.empty.classList.toggle('hidden', this.view.length > 0 || !this.columns.length);
      if (this.recordMode) this.renderRecord();
    }

    renderHead() {
      const total = 52 + this.widths.reduce((a, b) => a + b, 0);
      this.table.style.width = total + 'px';
      this.colgroup.innerHTML = '<col style="width:52px">' + this.widths.map((w) => `<col style="width:${w}px">`).join('');
      const th = this.columns.map((c, i) => {
        const s = this.sort && this.sort.col === i ? (this.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
        const key = this.keyIdx && this.keyIdx.includes(i) ? '<span class="pk" title="Clave">🔑</span>' : '';
        return `<th data-c="${i}" title="${esc(c.name)}${c.type ? ' : ' + esc(c.type) : ''}">${key}<span class="cn">${esc(c.name)}</span>${c.type ? `<span class="ct">${esc(c.type)}</span>` : ''}<span class="srt">${s}</span><div class="rz" data-c="${i}"></div></th>`;
      }).join('');
      this.thead.innerHTML = `<tr><th class="rownum corner" title="Seleccionar todo">#</th>${th}</tr>`;
    }

    renderBody() {
      const top = this.scroll.scrollTop;
      const h = this.scroll.clientHeight || 400;
      const n = this.view.length;
      const first = Math.max(0, Math.floor(top / ROW_H) - 15);
      const last = Math.min(n, first + Math.ceil(h / ROW_H) + 40);
      this.first = first;
      this.last = last;
      const cols = this.columns.length + 1;
      const parts = [];
      if (first > 0) parts.push(`<tr class="spacer"><td colspan="${cols}" style="height:${first * ROW_H}px"></td></tr>`);
      const s = this.normSel();
      for (let r = first; r < last; r++) {
        const row = this.rows[this.view[r]];
        const rc = row.state === 'new' ? 'new' : row.state === 'deleted' ? 'deleted' : '';
        const inRows = s && r >= s.r1 && r <= s.r2;
        let html = `<tr class="${rc}"><td class="rownum${inRows ? ' rsel' : ''}" data-r="${r}" data-c="-1">${row.state === 'new' ? '+' : r + 1 + this.rowOffset}</td>`;
        for (let c = 0; c < this.columns.length; c++) {
          const v = row.values[c];
          let cls = '';
          let content;
          if (v === null) { content = '<span class="null">[NULL]</span>'; }
          else if (typeof v === 'boolean') { content = v ? '☑ true' : '☐ false'; cls = 'bool'; }
          else {
            const t = String(v);
            content = esc(t.length > MAX_CELL ? t.slice(0, MAX_CELL) + '…' : t);
            if (typeof v === 'number') cls = 'num';
          }
          if (row.changed.has(c)) cls += ' changed';
          if (inRows && c >= s.c1 && c <= s.c2) cls += ' sel';
          if (this.sel && this.sel.r2 === r && this.sel.c2 === c) cls += ' focus';
          html += `<td class="${cls}" data-r="${r}" data-c="${c}">${content}</td>`;
        }
        parts.push(html + '</tr>');
      }
      if (last < n) parts.push(`<tr class="spacer"><td colspan="${cols}" style="height:${(n - last) * ROW_H}px"></td></tr>`);
      this.tbody.innerHTML = parts.join('');
    }

    renderRecord() {
      const s = this.sel;
      if (!s || !this.view.length) { this.record.innerHTML = '<div class="grid-empty">Sin fila seleccionada</div>'; return; }
      const row = this.rows[this.view[s.r2]];
      const trs = this.columns.map((c, i) => {
        const v = row.values[i];
        const val = v === null ? '<span class="null">[NULL]</span>' : esc(String(v));
        return `<tr class="${i === s.c2 ? 'focusrow' : ''}" data-c="${i}"><th>${esc(c.name)}<span class="ct">${esc(c.type || '')}</span></th><td class="${row.changed.has(i) ? 'changed' : ''}">${val}</td></tr>`;
      }).join('');
      this.record.innerHTML = `<div class="rec-nav"><button data-nav="-1">◀</button><span>Fila ${s.r2 + 1 + this.rowOffset} de ${this.view.length + this.rowOffset}</span><button data-nav="1">▶</button></div><table class="rec">${trs}</table>`;
    }

    toggleRecordMode(on) {
      this.recordMode = on === undefined ? !this.recordMode : on;
      this.scroll.classList.toggle('hidden', this.recordMode);
      this.record.classList.toggle('hidden', !this.recordMode);
      if (this.recordMode) this.renderRecord(); else this.renderBody();
      return this.recordMode;
    }

    toggleValuePanel(on) {
      this.panelOpen = on === undefined ? !this.panelOpen : on;
      this.panel.classList.toggle('hidden', !this.panelOpen);
      this.updatePanel();
      return this.panelOpen;
    }

    updatePanel() {
      if (!this.panelOpen) return;
      const ta = /** @type {HTMLTextAreaElement} */ (this.panel.querySelector('.vp-text'));
      const title = this.panel.querySelector('.vp-title');
      const apply = /** @type {HTMLElement} */ (this.panel.querySelector('.vp-apply'));
      const nul = /** @type {HTMLElement} */ (this.panel.querySelector('.vp-null'));
      const f = this.focusCell();
      const editable = !!this.opts.editable && !!f;
      apply.classList.toggle('hidden', !editable);
      nul.classList.toggle('hidden', !editable);
      ta.readOnly = !editable;
      if (!f) { ta.value = ''; if (title) title.textContent = ''; return; }
      const col = this.columns[f.c];
      if (title) title.textContent = `${col.name}${col.type ? ' (' + col.type + ')' : ''}`;
      ta.value = f.value === null ? '' : String(f.value);
      ta.placeholder = f.value === null ? '[NULL]' : '';
    }

    // ---------------------------------------------------------------- selección
    normSel() {
      const s = this.sel;
      if (!s) return null;
      return { r1: Math.min(s.r1, s.r2), r2: Math.max(s.r1, s.r2), c1: Math.min(s.c1, s.c2), c2: Math.max(s.c1, s.c2) };
    }

    focusCell() {
      if (!this.sel || !this.view.length) return null;
      const row = this.rows[this.view[this.sel.r2]];
      if (!row) return null;
      return { r: this.sel.r2, c: this.sel.c2, row, value: row.values[this.sel.c2] };
    }

    select(r, c, extend) {
      const n = this.view.length;
      if (!n) return;
      r = Math.max(0, Math.min(n - 1, r));
      c = Math.max(0, Math.min(this.columns.length - 1, c));
      if (extend && this.sel) { this.sel.r2 = r; this.sel.c2 = c; }
      else this.sel = { r1: r, c1: c, r2: r, c2: c };
      this.ensureVisible(r, c);
      this.renderBody();
      if (this.recordMode) this.renderRecord();
      this.fireFocus();
    }

    selectAll() {
      if (!this.view.length) return;
      this.sel = { r1: 0, c1: 0, r2: this.view.length - 1, c2: this.columns.length - 1 };
      this.renderBody();
    }

    fireFocus() {
      this.updatePanel();
      if (this.opts.onFocus) this.opts.onFocus(this.focusCell());
    }

    ensureVisible(r, c) {
      const sc = this.scroll;
      const headH = this.thead.offsetHeight || ROW_H;
      const y = r * ROW_H;
      if (y < sc.scrollTop) sc.scrollTop = y;
      else if (y + ROW_H > sc.scrollTop + sc.clientHeight - headH) sc.scrollTop = y + ROW_H - sc.clientHeight + headH;
      let x = 52;
      for (let i = 0; i < c; i++) x += this.widths[i];
      const w = this.widths[c] || 0;
      if (x - 52 < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 52);
      else if (x + w > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = x + w - sc.clientWidth;
    }

    /** Filas y columnas seleccionadas (valores) */
    selection() {
      const s = this.normSel();
      if (!s) return { columns: [], rows: [] };
      const cols = [];
      for (let c = s.c1; c <= s.c2; c++) cols.push(c);
      const rows = [];
      for (let r = s.r1; r <= s.r2; r++) {
        const row = this.rows[this.view[r]];
        rows.push(cols.map((c) => row.values[c]));
      }
      return { columns: cols.map((c) => this.columns[c].name), rows };
    }

    selectedRowIndexes() {
      const s = this.normSel();
      if (!s) return [];
      const out = [];
      for (let r = s.r1; r <= s.r2; r++) out.push(this.view[r]);
      return out;
    }

    // ---------------------------------------------------------------- edición
    startEdit(r, c) {
      if (!this.opts.editable) return;
      const row = this.rows[this.view[r]];
      if (!row || row.state === 'deleted') return;
      this.cancelEdit();
      this.select(r, c, false);
      const td = /** @type {HTMLElement|null} */ (this.tbody.querySelector(`td[data-r="${r}"][data-c="${c}"]`));
      if (!td) return;
      const v = row.values[c];
      const text = v === null ? '' : String(v);
      const multi = text.includes('\n') || text.length > 200;
      const el = /** @type {HTMLInputElement} */ (document.createElement(multi ? 'textarea' : 'input'));
      el.className = 'cell-editor' + (multi ? ' multi' : '');
      el.value = text;
      el.style.left = td.offsetLeft + 'px';
      el.style.top = td.offsetTop + 'px';
      el.style.width = Math.max(td.offsetWidth, multi ? 320 : 0) + 'px';
      el.style.height = (multi ? 140 : td.offsetHeight) + 'px';
      this.scroll.appendChild(el);
      el.focus();
      el.select();
      this.editor = { el, r, c };
      el.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { this.cancelEdit(); this.scroll.focus(); }
        else if (e.key === 'Enter' && (!multi || e.ctrlKey)) { e.preventDefault(); this.commitEdit(); this.scroll.focus(); this.select(r + 1, c, false); }
        else if (e.key === 'Tab') { e.preventDefault(); this.commitEdit(); this.scroll.focus(); this.select(r, c + (e.shiftKey ? -1 : 1), false); }
      });
      el.addEventListener('blur', () => this.commitEdit());
    }

    commitEdit() {
      const ed = this.editor;
      if (!ed) return;
      this.editor = null;
      ed.el.remove();
      this.setCell(ed.r, ed.c, ed.el.value);
    }

    cancelEdit() {
      const ed = this.editor;
      if (!ed) return;
      this.editor = null;
      ed.el.remove();
    }

    setCell(r, c, value) {
      const row = this.rows[this.view[r]];
      if (!row || row.state === 'deleted') return;
      if (same(row.values[c], value)) return;
      row.values[c] = value;
      if (row.state !== 'new') {
        if (same(row.orig[c], value)) row.changed.delete(c); else row.changed.add(c);
      } else row.changed.add(c);
      this.renderBody();
      if (this.recordMode) this.renderRecord();
      this.updatePanel();
      this.changed();
    }

    setNullSelection() {
      const s = this.normSel();
      if (!s || !this.opts.editable) return;
      for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) this.setCell(r, c, null);
    }

    addRow(copyFrom) {
      const values = copyFrom ? copyFrom.values.slice() : this.columns.map(() => null);
      const row = { orig: null, values, state: 'new', changed: new Set(values.map((v, i) => (v !== null ? i : -1)).filter((i) => i >= 0)) };
      this.rows.push(row);
      this.view.push(this.rows.length - 1);
      this.empty.classList.add('hidden');
      this.select(this.view.length - 1, 0, false);
      this.changed();
    }

    duplicateRows() {
      const idx = this.selectedRowIndexes();
      for (const i of idx) this.addRow(this.rows[i]);
    }

    deleteRows() {
      if (!this.opts.editable) return;
      const idx = this.selectedRowIndexes();
      const remove = new Set();
      for (const i of idx) {
        const row = this.rows[i];
        if (row.state === 'new') remove.add(i);
        else row.state = row.state === 'deleted' ? null : 'deleted';
      }
      if (remove.size) {
        this.rows = this.rows.filter((_, i) => !remove.has(i));
        this.applyView();
        if (this.sel) this.sel = { r1: Math.min(this.sel.r1, this.view.length - 1), c1: this.sel.c1, r2: Math.min(this.sel.r1, this.view.length - 1), c2: this.sel.c1 };
        if (this.sel && this.sel.r1 < 0) this.sel = null;
      }
      this.renderBody();
      this.changed();
    }

    revert() {
      this.rows = this.rows.filter((r) => r.state !== 'new');
      for (const r of this.rows) { r.values = r.orig.slice(); r.state = null; r.changed.clear(); }
      this.applyView();
      this.renderAll();
      this.changed();
    }

    getChanges() {
      const updates = [], inserts = [], deletes = [];
      for (const row of this.rows) {
        if (row.state === 'deleted') deletes.push({ orig: row.orig });
        else if (row.state === 'new') {
          const values = {};
          row.values.forEach((v, i) => { if (v !== null) values[i] = v; });
          inserts.push({ values });
        } else if (row.changed.size) {
          const values = {};
          row.changed.forEach((i) => { values[i] = row.values[i]; });
          updates.push({ orig: row.orig, values });
        }
      }
      return { updates, inserts, deletes };
    }

    changeCount() {
      const ch = this.getChanges();
      return ch.updates.length + ch.inserts.length + ch.deletes.length;
    }

    changed() {
      if (this.opts.onChange) this.opts.onChange(this.changeCount());
    }

    // ---------------------------------------------------------------- menú contextual
    showMenu(x, y) {
      const ed = !!this.opts.editable;
      const f = this.focusCell();
      const items = [
        ['copy', 'Copiar', 'Ctrl+C'],
        ['copyHeader', 'Copiar con encabezados'],
        ['copyValue', 'Copiar valor de la celda'],
        ['-'],
        ['copy:csv', 'Copiar como CSV'],
        ['copy:json', 'Copiar como JSON'],
        ['copy:sql', 'Copiar como SQL INSERT'],
        ['copy:markdown', 'Copiar como Markdown'],
        ['copy:html', 'Copiar como HTML'],
        ['-'],
        ['viewValue', 'Ver / editar valor (panel)'],
        ['openValue', 'Abrir valor en editor'],
        ['record', this.recordMode ? 'Vista de grilla' : 'Vista de registro'],
      ];
      if (this.opts.tableMode && f) {
        items.push(['-'], ['filterEq', 'Filtrar: columna = valor'], ['filterNe', 'Filtrar: columna <> valor'], ['filterNull', f.value === null ? 'Filtrar: columna IS NULL' : 'Filtrar: columna IS NOT NULL'], ['filterClear', 'Quitar filtro']);
      }
      if (ed) {
        items.push(['-'], ['edit', 'Editar celda', 'F2'], ['setNull', 'Establecer NULL'], ['addRow', 'Agregar fila'], ['dupRow', 'Duplicar fila(s)'], ['delRow', 'Eliminar / restaurar fila(s)', 'Supr']);
      }
      items.push(['-'], ['export', 'Exportar datos...']);
      this.menu.innerHTML = items.map((it) => it[0] === '-' ? '<div class="sep"></div>' :
        `<div class="mi" data-a="${it[0]}"><span>${esc(it[1])}</span><span class="kb">${it[2] || ''}</span></div>`).join('');
      this.menu.classList.remove('hidden');
      const hr = this.host.getBoundingClientRect();
      const mw = this.menu.offsetWidth, mh = this.menu.offsetHeight;
      this.menu.style.left = Math.max(0, Math.min(x - hr.left, hr.width - mw - 4)) + 'px';
      this.menu.style.top = Math.max(0, Math.min(y - hr.top, hr.height - mh - 4)) + 'px';
    }

    hideMenu() {
      this.menu.classList.add('hidden');
    }

    action(a) {
      const act = this.opts.onAction || (() => undefined);
      const f = this.focusCell();
      if (a === 'copy' || a === 'copyHeader') { const s = this.selection(); act('copy', { format: 'tsv', header: a === 'copyHeader', ...s }); }
      else if (a.startsWith('copy:')) { const s = this.selection(); act('copy', { format: a.slice(5), header: true, ...s }); }
      else if (a === 'copyValue' && f) act('copyText', { text: f.value === null ? '' : String(f.value) });
      else if (a === 'viewValue') this.toggleValuePanel(true);
      else if (a === 'openValue' && f) act('openValue', { value: f.value, column: this.columns[f.c].name });
      else if (a === 'record') { this.toggleRecordMode(); act('recordMode', { on: this.recordMode }); }
      else if (a === 'filterEq' && f) act('filter', { column: this.columns[f.c].name, op: f.value === null ? 'IS NULL' : '=', value: f.value });
      else if (a === 'filterNe' && f) act('filter', { column: this.columns[f.c].name, op: f.value === null ? 'IS NOT NULL' : '<>', value: f.value });
      else if (a === 'filterNull' && f) act('filter', { column: this.columns[f.c].name, op: f.value === null ? 'IS NULL' : 'IS NOT NULL', value: null });
      else if (a === 'filterClear') act('filterClear', {});
      else if (a === 'edit' && f) this.startEdit(f.r, f.c);
      else if (a === 'setNull') this.setNullSelection();
      else if (a === 'addRow') this.addRow();
      else if (a === 'dupRow') this.duplicateRows();
      else if (a === 'delRow') this.deleteRows();
      else if (a === 'export') act('export', {});
    }

    // ---------------------------------------------------------------- eventos
    bind() {
      let raf = 0;
      this.scroll.addEventListener('scroll', () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const top = this.scroll.scrollTop;
          const firstNeeded = Math.floor(top / ROW_H);
          const visible = Math.ceil((this.scroll.clientHeight || 400) / ROW_H);
          if (this.editor) return;
          if (firstNeeded < this.first + 5 || firstNeeded + visible > this.last - 5) this.renderBody();
        });
      });
      new ResizeObserver(() => { if (!this.editor) this.renderBody(); }).observe(this.scroll);

      let dragging = false;
      this.tbody.addEventListener('mousedown', (e) => {
        const td = /** @type {HTMLElement} */ (e.target).closest('td[data-r]');
        if (!td || e.button === 2 && this.isInSel(td)) return;
        const r = Number(td.getAttribute('data-r')), c = Number(td.getAttribute('data-c'));
        this.scroll.focus();
        if (c === -1) {
          if (e.shiftKey && this.sel) { this.sel.r2 = r; this.sel.c1 = 0; this.sel.c2 = this.columns.length - 1; }
          else this.sel = { r1: r, c1: 0, r2: r, c2: this.columns.length - 1 };
          this.renderBody();
          if (this.recordMode) this.renderRecord();
          this.fireFocus();
        } else this.select(r, c, e.shiftKey);
        dragging = e.button === 0;
      });
      this.tbody.addEventListener('mouseover', (e) => {
        if (!dragging || !this.sel) return;
        const td = /** @type {HTMLElement} */ (e.target).closest('td[data-r]');
        if (!td) return;
        const r = Number(td.getAttribute('data-r')), c = Number(td.getAttribute('data-c'));
        if (c < 0) return;
        if (this.sel.r2 !== r || this.sel.c2 !== c) { this.sel.r2 = r; this.sel.c2 = c; this.renderBody(); }
      });
      window.addEventListener('mouseup', () => { if (dragging) { dragging = false; this.fireFocus(); } });
      this.tbody.addEventListener('dblclick', (e) => {
        const td = /** @type {HTMLElement} */ (e.target).closest('td[data-r]');
        if (!td) return;
        const r = Number(td.getAttribute('data-r')), c = Number(td.getAttribute('data-c'));
        if (c < 0) return;
        if (this.opts.editable) this.startEdit(r, c);
        else this.toggleValuePanel(true);
      });
      this.host.addEventListener('contextmenu', (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        if (t.closest('.valpanel') || t.closest('thead')) return;
        e.preventDefault();
        const td = t.closest('td[data-r]');
        if (td && !this.isInSel(td)) {
          const r = Number(td.getAttribute('data-r')), c = Number(td.getAttribute('data-c'));
          if (c >= 0) this.select(r, c, false);
        }
        this.showMenu(e.clientX, e.clientY);
      });
      this.menu.addEventListener('mousedown', (e) => e.stopPropagation());
      this.menu.addEventListener('click', (e) => {
        const mi = /** @type {HTMLElement} */ (e.target).closest('.mi');
        if (!mi) return;
        this.hideMenu();
        this.action(mi.getAttribute('data-a') || '');
      });
      window.addEventListener('mousedown', () => this.hideMenu());
      window.addEventListener('blur', () => this.hideMenu());

      // encabezados: ordenar y redimensionar
      this.thead.addEventListener('click', (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        if (t.classList.contains('rz')) return;
        if (t.closest('.corner')) { this.selectAll(); return; }
        const th = t.closest('th[data-c]');
        if (!th) return;
        const c = Number(th.getAttribute('data-c'));
        let dir = 'asc';
        if (this.sort && this.sort.col === c) dir = this.sort.dir === 'asc' ? 'desc' : '';
        this.sort = dir ? { col: c, dir } : null;
        if (this.opts.serverSort && this.opts.onSort) { this.opts.onSort(this.sort); this.renderHead(); return; }
        this.applyView();
        this.renderAll();
      });
      this.thead.addEventListener('mousedown', (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        if (!t.classList.contains('rz')) return;
        e.preventDefault();
        e.stopPropagation();
        const c = Number(t.getAttribute('data-c'));
        const startX = e.clientX, startW = this.widths[c];
        const col = /** @type {HTMLElement} */ (this.colgroup.children[c + 1]);
        const move = (ev) => {
          this.widths[c] = Math.max(40, startW + ev.clientX - startX);
          col.style.width = this.widths[c] + 'px';
          this.table.style.width = 52 + this.widths.reduce((a, b) => a + b, 0) + 'px';
        };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });

      // teclado
      this.scroll.addEventListener('keydown', (e) => {
        if (!this.sel) return;
        const k = e.key;
        const ctrl = e.ctrlKey || e.metaKey;
        const page = Math.max(1, Math.floor(this.scroll.clientHeight / ROW_H) - 2);
        const { r2, c2 } = this.sel;
        let handled = true;
        if (k === 'ArrowDown') this.select(ctrl ? this.view.length - 1 : r2 + 1, c2, e.shiftKey);
        else if (k === 'ArrowUp') this.select(ctrl ? 0 : r2 - 1, c2, e.shiftKey);
        else if (k === 'ArrowRight') this.select(r2, ctrl ? this.columns.length - 1 : c2 + 1, e.shiftKey);
        else if (k === 'ArrowLeft') this.select(r2, ctrl ? 0 : c2 - 1, e.shiftKey);
        else if (k === 'PageDown') this.select(r2 + page, c2, e.shiftKey);
        else if (k === 'PageUp') this.select(r2 - page, c2, e.shiftKey);
        else if (k === 'Home') this.select(ctrl ? 0 : r2, 0, e.shiftKey);
        else if (k === 'End') this.select(ctrl ? this.view.length - 1 : r2, this.columns.length - 1, e.shiftKey);
        else if (k === 'Tab') this.select(r2, c2 + (e.shiftKey ? -1 : 1), false);
        else if (ctrl && (k === 'c' || k === 'C')) this.action(e.shiftKey ? 'copyHeader' : 'copy');
        else if (ctrl && (k === 'a' || k === 'A')) this.selectAll();
        else if ((k === 'Enter' || k === 'F2') && this.opts.editable) this.startEdit(r2, c2);
        else if (k === 'Enter' && !this.opts.editable) this.toggleValuePanel(true);
        else if (k === 'Delete' && this.opts.editable) this.deleteRows();
        else if (k === 'Backspace' && this.opts.editable && e.shiftKey) this.setNullSelection();
        else if (ctrl && (k === 'n' || k === 'N') && this.opts.editable) this.addRow();
        else if (k === 'Escape') this.hideMenu();
        else if (this.opts.editable && k.length === 1 && !ctrl && !e.altKey) {
          // empezar a escribir reemplaza el contenido
          this.startEdit(r2, c2);
          if (this.editor) { this.editor.el.value = k; }
        } else handled = false;
        if (handled) e.preventDefault();
      });

      // vista de registro
      this.record.addEventListener('click', (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        const nav = t.getAttribute('data-nav');
        if (nav && this.sel) { this.select(this.sel.r2 + Number(nav), this.sel.c2, false); return; }
        const tr = t.closest('tr[data-c]');
        if (tr && this.sel) {
          this.sel.c1 = this.sel.c2 = Number(tr.getAttribute('data-c'));
          this.sel.r1 = this.sel.r2;
          this.renderRecord();
          this.fireFocus();
        }
      });
      this.record.addEventListener('dblclick', () => this.toggleValuePanel(true));

      // panel de valor
      const ta = /** @type {HTMLTextAreaElement} */ (this.panel.querySelector('.vp-text'));
      this.panel.querySelector('.vp-close')?.addEventListener('click', () => this.toggleValuePanel(false));
      this.panel.querySelector('.vp-json')?.addEventListener('click', () => {
        try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); } catch { /* no es JSON */ }
      });
      this.panel.querySelector('.vp-open')?.addEventListener('click', () => {
        const f = this.focusCell();
        if (f && this.opts.onAction) this.opts.onAction('openValue', { value: ta.value, column: this.columns[f.c].name });
      });
      this.panel.querySelector('.vp-apply')?.addEventListener('click', () => {
        const f = this.focusCell();
        if (f) this.setCell(f.r, f.c, ta.value);
      });
      this.panel.querySelector('.vp-null')?.addEventListener('click', () => {
        const f = this.focusCell();
        if (f) this.setCell(f.r, f.c, null);
      });
    }

    isInSel(td) {
      const s = this.normSel();
      if (!s) return false;
      const r = Number(td.getAttribute('data-r')), c = Number(td.getAttribute('data-c'));
      return r >= s.r1 && r <= s.r2 && (c === -1 || (c >= s.c1 && c <= s.c2));
    }
  }

  // @ts-ignore
  window.HbdGrid = Grid;
})();
