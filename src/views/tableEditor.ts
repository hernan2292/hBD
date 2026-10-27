import * as fs from 'fs';
import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';
import { BaseDriver } from '../drivers';
import { ColumnInfo, KIND_LABELS, ObjectRef } from '../drivers/types';
import { errorText } from '../editor/sqlEditor';
import { formatData } from '../util/exporter';
import { CellValue, normalizeRows } from '../util/values';
import { askExportTarget, buildHtml, handleGridMessage, notifyExported, pickExportFormat } from './webview';

export type TableTab = 'data' | 'props' | 'ddl';

interface Changes {
  updates: { orig: CellValue[]; values: Record<string, CellValue> }[];
  inserts: { values: Record<string, CellValue> }[];
  deletes: { orig: CellValue[] }[];
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** Editor de una tabla/vista: datos paginados y editables, propiedades y DDL. */
export class TableEditorPanel {
  private static panels = new Map<string, TableEditorPanel>();
  private readonly panel: vscode.WebviewPanel;
  private columns: ColumnInfo[] = [];
  private resultCols: string[] = [];
  private where = '';
  private orderBy = '';
  private pageSize: number;
  private page = 0;
  private ready = false;

  static open(extUri: vscode.Uri, cm: ConnectionManager, connId: string, ref: ObjectRef, tab: TableTab, onChanged: () => void): void {
    const key = `${connId}|${ref.database}|${ref.schema ?? ''}|${ref.name}`;
    const existing = TableEditorPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      existing.post({ type: 'tab', tab });
      return;
    }
    const p = new TableEditorPanel(extUri, cm, connId, ref, tab, onChanged);
    TableEditorPanel.panels.set(key, p);
    p.panel.onDidDispose(() => TableEditorPanel.panels.delete(key));
  }

  private constructor(
    private readonly extUri: vscode.Uri,
    private readonly cm: ConnectionManager,
    private readonly connId: string,
    private readonly ref: ObjectRef,
    private readonly initialTab: TableTab,
    private readonly onChanged: () => void
  ) {
    this.pageSize = vscode.workspace.getConfiguration('hbd').get<number>('tableEditor.pageSize', 200);
    const conn = cm.get(connId);
    this.panel = vscode.window.createWebviewPanel('hbd.table', `${ref.name} · ${conn?.name ?? ''}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extUri, 'media')]
    });
    this.panel.iconPath = new vscode.ThemeIcon(ref.kind === 'table' ? 'table' : 'eye');
    this.panel.webview.html = buildHtml(this.panel.webview, extUri, {
      title: ref.name,
      scripts: ['grid.js', 'table.js'],
      body: `
<div class="tabs" id="mainTabs">
  <div class="tab" data-tab="data">Datos</div>
  <div class="tab" data-tab="props">Propiedades</div>
  <div class="tab" data-tab="ddl">DDL</div>
  <span style="flex:1"></span>
  <div class="status" id="title" style="padding:5px 10px"></div>
</div>
<section id="tab-data" style="flex:1;display:flex;flex-direction:column;min-height:0">
  <div class="toolbar">
    <label>WHERE</label><input id="where" style="flex:1;min-width:160px" placeholder="condición, p. ej. id > 10">
    <label>ORDER BY</label><input id="orderBy" style="width:180px" placeholder="columna DESC">
    <button id="apply" class="primary" title="Aplicar filtro (Enter)">Aplicar</button>
    <button id="reload" title="Recargar (F5)">⟳</button>
    <span class="sep"></span>
    <button id="first" title="Primera página">⏮</button>
    <button id="prev" title="Página anterior">◀</button>
    <span id="pageInfo" class="status"></span>
    <button id="next" title="Página siguiente">▶</button>
    <select id="pageSize" title="Filas por página">
      <option>50</option><option>100</option><option>200</option><option>500</option><option>1000</option><option>5000</option>
    </select>
    <button id="count" title="Contar filas totales">Contar</button>
  </div>
  <div class="toolbar">
    <span id="editTools">
      <button id="addRow" title="Agregar fila (Ctrl+N)">＋ Fila</button>
      <button id="dupRow" title="Duplicar fila(s)">Duplicar</button>
      <button id="delRow" title="Eliminar / restaurar fila(s) (Supr)">Eliminar</button>
      <span class="sep"></span>
      <button id="save" class="primary" title="Guardar cambios (Ctrl+S)" disabled>Guardar</button>
      <button id="revert" title="Descartar cambios" disabled>Descartar</button>
      <button id="preview" title="Ver el SQL que se ejecutará" disabled>Ver SQL</button>
      <span class="sep"></span>
    </span>
    <button id="btnRecord" title="Vista de registro">Registro</button>
    <button id="btnPanel" title="Panel de valor">Valor</button>
    <button id="export" title="Exportar todos los datos (con el filtro actual)">Exportar…</button>
    <button id="openSql" title="Abrir consulta en editor SQL">SQL</button>
    <input id="quick" type="search" placeholder="Buscar en la página…" style="width:170px">
    <span class="grow"></span>
    <span id="status" class="status"></span>
  </div>
  <div id="grid" style="flex:1;display:flex;min-height:0"></div>
</section>
<section id="tab-props" class="hidden" style="flex:1;overflow:auto;padding:8px 12px"><div id="props" class="placeholder">Cargando…</div></section>
<section id="tab-ddl" class="hidden" style="flex:1;display:flex;flex-direction:column;min-height:0">
  <div class="toolbar"><button id="ddlOpen" class="primary">Abrir en editor SQL</button><button id="ddlCopy">Copiar</button><button id="ddlRefresh">⟳</button></div>
  <pre id="ddl" class="ddl">Cargando…</pre>
</section>`
    });
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => {
      this.post({ type: 'error', text: errorText(e) });
    }));
  }

  private post(msg: any): void {
    if (this.ready) this.panel.webview.postMessage(msg);
  }

  private async driver(): Promise<BaseDriver> {
    return this.cm.getDriver(this.connId);
  }

  private get editable(): boolean {
    return this.ref.kind === 'table' && !this.cm.get(this.connId)?.readOnly;
  }

  private async onMessage(m: any): Promise<void> {
    const d = await this.driver();
    if (await handleGridMessage(m, { quoteIdent: s => d.quoteIdent(s), literal: v => d.literal(v), tableName: d.qualified(this.ref) })) return;
    switch (m.type) {
      case 'ready': {
        this.ready = true;
        const conn = this.cm.get(this.connId);
        this.post({
          type: 'init',
          tab: this.initialTab,
          title: `${KIND_LABELS[this.ref.kind]}: ${d.qualified(this.ref)} — ${conn?.name ?? ''}`,
          editable: this.editable,
          pageSize: this.pageSize
        });
        await this.loadMeta(d);
        await this.loadData(d);
        await this.loadDDL(d);
        return;
      }
      case 'load':
        if (typeof m.where === 'string') this.where = m.where.trim();
        if (typeof m.orderBy === 'string') this.orderBy = m.orderBy.trim();
        if (typeof m.page === 'number') this.page = Math.max(0, m.page);
        if (typeof m.pageSize === 'number') this.pageSize = m.pageSize;
        if (m.sort !== undefined) {
          this.orderBy = m.sort ? `${d.quoteIdent(m.sort.column)} ${m.sort.dir === 'desc' ? 'DESC' : 'ASC'}` : '';
          this.page = 0;
        }
        await this.loadData(d);
        return;
      case 'filter': {
        const col = d.quoteIdent(m.column);
        const cond = m.op === 'IS NULL' || m.op === 'IS NOT NULL' ? `${col} ${m.op}` : `${col} ${m.op} ${d.literal(m.value)}`;
        this.where = this.where ? `(${this.where}) AND ${cond}` : cond;
        this.page = 0;
        await this.loadData(d);
        return;
      }
      case 'filterClear':
        this.where = '';
        this.page = 0;
        await this.loadData(d);
        return;
      case 'count': {
        const r = await d.execute(d.countSql(this.ref, this.where), this.ref.database);
        this.post({ type: 'count', total: Number(r.rows[0]?.[0] ?? 0) });
        return;
      }
      case 'save': {
        const stmts = this.buildStatements(d, m.changes as Changes);
        if (!stmts.length) return;
        const affected = await d.executeBatch(stmts, this.ref.database);
        this.cm.fireTxChange(this.connId);
        vscode.window.setStatusBarMessage(`hBD: ${stmts.length} sentencia(s) ejecutadas, ${affected} fila(s) afectadas${d.autoCommit ? '' : ' (pendiente de commit)'}`, 4000);
        await this.loadData(d);
        this.onChanged();
        return;
      }
      case 'preview': {
        const stmts = this.buildStatements(d, m.changes as Changes);
        const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: stmts.map(s => s + ';').join('\n') + '\n' });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        return;
      }
      case 'export': {
        const fmt = await pickExportFormat();
        if (!fmt) return;
        const target = await askExportTarget(this.ref.name, fmt.id);
        if (!target) return;
        const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exportando ${this.ref.name}…` },
          () => d.execute(d.selectAllSql(this.ref, this.where, this.orderBy), this.ref.database));
        const text = formatData(fmt.id, r.columns.map(c => c.name), normalizeRows(r.rows),
          { quoteIdent: s => d.quoteIdent(s), literal: v => d.literal(v), tableName: d.qualified(this.ref) });
        await fs.promises.writeFile(target.fsPath, fmt.id === 'csv' ? '﻿' + text : text, 'utf8');
        notifyExported(target, r.rows.length);
        return;
      }
      case 'openQuery': {
        const sql = d.selectPageSql(this.ref, this.where, this.orderBy, this.pageSize, this.page * this.pageSize);
        await vscode.commands.executeCommand('hbd.newSqlEditor', { connId: this.connId, database: this.ref.database, content: sql + ';\n' });
        return;
      }
      case 'ddlOpen':
        await vscode.commands.executeCommand('hbd.newSqlEditor', { connId: this.connId, database: this.ref.database, content: m.text });
        return;
      case 'ddlRefresh':
        await this.loadDDL(d);
        return;
    }
  }

  private async loadMeta(d: BaseDriver): Promise<void> {
    try {
      const isTable = this.ref.kind === 'table';
      const [cols, idx, fks, trg] = await Promise.all([
        d.listColumns(this.ref),
        isTable ? d.listIndexes(this.ref) : Promise.resolve([]),
        isTable ? d.listForeignKeys(this.ref) : Promise.resolve([]),
        isTable ? d.listTriggers(this.ref) : Promise.resolve([])
      ]);
      this.columns = cols;
      let html = `<h3>Columnas (${cols.length})</h3><table class="props"><tr><th>#</th><th>Nombre</th><th>Tipo</th><th>Nulo</th><th>Default</th><th>PK</th><th>Auto</th><th>Comentario</th></tr>` +
        cols.map(c => `<tr><td>${c.ordinal}</td><td>${esc(c.name)}</td><td>${esc(c.dataType)}</td><td>${c.nullable ? 'Sí' : 'No'}</td><td>${esc(c.defaultValue ?? '')}</td><td>${c.isPrimaryKey ? '🔑' : ''}</td><td>${c.isAutoIncrement ? '✓' : ''}</td><td>${esc(c.comment ?? '')}</td></tr>`).join('') + '</table>';
      if (isTable) {
        html += `<h3>Índices (${idx.length})</h3><table class="props"><tr><th>Nombre</th><th>Columnas</th><th>Único</th><th>PK</th><th>Definición</th></tr>` +
          idx.map(i => `<tr><td>${esc(i.name)}</td><td>${esc(i.columns.join(', '))}</td><td>${i.unique ? 'Sí' : ''}</td><td>${i.primary ? '🔑' : ''}</td><td>${esc(i.definition ?? '')}</td></tr>`).join('') + '</table>';
        html += `<h3>Claves foráneas (${fks.length})</h3><table class="props"><tr><th>Nombre</th><th>Columnas</th><th>Referencia</th><th>ON UPDATE</th><th>ON DELETE</th></tr>` +
          fks.map(f => `<tr><td>${esc(f.name)}</td><td>${esc(f.columns.join(', '))}</td><td>${esc((f.refSchema ? f.refSchema + '.' : '') + f.refTable)} (${esc(f.refColumns.join(', '))})</td><td>${esc(f.onUpdate ?? '')}</td><td>${esc(f.onDelete ?? '')}</td></tr>`).join('') + '</table>';
        html += `<h3>Triggers (${trg.length})</h3><table class="props"><tr><th>Nombre</th></tr>` + trg.map(t => `<tr><td>${esc(t.name)}</td></tr>`).join('') + '</table>';
      }
      this.post({ type: 'props', html });
    } catch (e) {
      this.post({ type: 'props', html: `<div class="msg err">${esc(errorText(e))}</div>` });
    }
  }

  private async loadDDL(d: BaseDriver): Promise<void> {
    try {
      this.post({ type: 'ddl', text: await d.getDDL(this.ref) });
    } catch (e) {
      this.post({ type: 'ddl', text: `-- Error: ${errorText(e)}` });
    }
  }

  private async loadData(d: BaseDriver): Promise<void> {
    const sql = d.selectPageSql(this.ref, this.where, this.orderBy, this.pageSize + 1, this.page * this.pageSize);
    this.post({ type: 'loading' });
    try {
      const r = await d.execute(sql, this.ref.database);
      const hasMore = r.rows.length > this.pageSize;
      const rows = normalizeRows(hasMore ? r.rows.slice(0, this.pageSize) : r.rows);
      this.resultCols = r.columns.map(c => c.name);
      const meta = new Map(this.columns.map(c => [c.name, c]));
      let keyIdx = this.resultCols.map((n, i) => (meta.get(n)?.isPrimaryKey ? i : -1)).filter(i => i >= 0);
      const noKey = keyIdx.length === 0;
      if (noKey) keyIdx = [];
      this.post({
        type: 'data',
        columns: r.columns.map(c => ({ name: c.name, type: meta.get(c.name)?.dataType ?? c.type })),
        rows,
        keyIdx,
        noKey,
        page: this.page,
        pageSize: this.pageSize,
        hasMore,
        where: this.where,
        orderBy: this.orderBy,
        duration: r.durationMs,
        sql
      });
    } catch (e) {
      this.post({ type: 'error', text: errorText(e), where: this.where, orderBy: this.orderBy });
    }
  }

  private buildStatements(d: BaseDriver, ch: Changes): string[] {
    const q = (s: string) => d.quoteIdent(s);
    const cols = this.resultCols;
    const meta = new Map(this.columns.map(c => [c.name, c]));
    let keyIdx = cols.map((n, i) => (meta.get(n)?.isPrimaryKey ? i : -1)).filter(i => i >= 0);
    if (!keyIdx.length) keyIdx = cols.map((_, i) => i);
    const table = d.qualified(this.ref);
    const where = (orig: CellValue[]) => keyIdx.map(i => orig[i] === null ? `${q(cols[i])} IS NULL` : `${q(cols[i])} = ${d.literal(orig[i])}`).join(' AND ');
    const out: string[] = [];
    for (const del of ch.deletes ?? []) out.push(`DELETE FROM ${table} WHERE ${where(del.orig)}`);
    for (const up of ch.updates ?? []) {
      const sets = Object.entries(up.values).map(([i, v]) => `${q(cols[Number(i)])} = ${d.literal(v)}`);
      if (sets.length) out.push(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${where(up.orig)}`);
    }
    for (const ins of ch.inserts ?? []) {
      const entries = Object.entries(ins.values);
      if (!entries.length) out.push(d.insertDefaultSql(this.ref));
      else out.push(`INSERT INTO ${table} (${entries.map(([i]) => q(cols[Number(i)])).join(', ')}) VALUES (${entries.map(([, v]) => d.literal(v)).join(', ')})`);
    }
    return out;
  }
}
