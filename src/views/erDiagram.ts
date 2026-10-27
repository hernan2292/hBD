import * as fs from 'fs';
import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';
import { ObjectRef } from '../drivers/types';
import { errorText } from '../editor/sqlEditor';
import { buildHtml } from './webview';

const MAX_TABLES = 200;

/** Diagrama entidad-relación de un esquema (o de una tabla y sus vecinas). */
export class ErDiagramPanel {
  static open(extUri: vscode.Uri, cm: ConnectionManager, connId: string, database: string, schema: string | undefined, focus: string | undefined,
    openTable: (ref: ObjectRef) => void): void {
    const conn = cm.get(connId);
    const title = `ER: ${focus ?? schema ?? database}`;
    const panel = vscode.window.createWebviewPanel('hbd.erd', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extUri, 'media')]
    });
    panel.iconPath = new vscode.ThemeIcon('type-hierarchy-sub');
    panel.webview.html = buildHtml(panel.webview, extUri, {
      title,
      scripts: ['erd.js'],
      body: `
<div class="toolbar">
  <button id="fit" title="Ajustar a la ventana">Ajustar</button>
  <button id="zin" title="Acercar">＋</button>
  <button id="zout" title="Alejar">－</button>
  <button id="relayout" title="Reorganizar">Reorganizar</button>
  <label class="chk"><input id="keysOnly" type="checkbox"> Solo claves</label>
  <input id="search" type="search" placeholder="Buscar tabla…" style="width:160px">
  <button id="exportSvg">Exportar SVG</button>
  <span class="grow"></span>
  <span id="status" class="status">Cargando metadatos…</span>
</div>
<div id="canvas" style="flex:1;position:relative;overflow:hidden;cursor:grab"></div>`
    });
    panel.webview.onDidReceiveMessage(async m => {
      if (m.type === 'ready') {
        try {
          const data = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'hBD: leyendo metadatos para ER' }, async () => {
            const d = await cm.getDriver(connId);
            let tables = await d.listObjects(database, schema, 'table');
            const truncated = tables.length > MAX_TABLES && !focus;
            if (truncated) tables = tables.slice(0, MAX_TABLES);
            const info = [];
            for (const t of tables) {
              const [cols, fks] = await Promise.all([d.listColumns(t), d.listForeignKeys(t)]);
              info.push({ name: t.name, schema: t.schema, columns: cols, fks });
            }
            let list = info;
            if (focus) {
              const keep = new Set([focus]);
              for (const t of info) {
                if (t.name === focus) t.fks.forEach(f => keep.add(f.refTable));
                if (t.fks.some(f => f.refTable === focus)) keep.add(t.name);
              }
              list = info.filter(t => keep.has(t.name));
            }
            return { tables: list, truncated };
          });
          panel.webview.postMessage({
            type: 'data',
            title: `${conn?.name ?? ''} · ${database}${schema ? '.' + schema : ''}`,
            tables: data.tables.map(t => ({
              name: t.name,
              schema: t.schema,
              columns: t.columns.map(c => ({ name: c.name, type: c.dataType, pk: c.isPrimaryKey, nullable: c.nullable, fk: t.fks.some(f => f.columns.includes(c.name)) })),
              fks: t.fks.map(f => ({ name: f.name, columns: f.columns, refTable: f.refTable, refColumns: f.refColumns }))
            })),
            truncated: data.truncated,
            focus
          });
        } catch (e) {
          panel.webview.postMessage({ type: 'error', text: errorText(e) });
        }
      } else if (m.type === 'openTable') {
        openTable({ database, schema, name: m.name, kind: 'table' });
      } else if (m.type === 'saveSvg') {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        const name = `er_${focus ?? schema ?? database}.svg`;
        const target = await vscode.window.showSaveDialog({
          defaultUri: folder ? vscode.Uri.joinPath(folder, name) : vscode.Uri.file(name),
          filters: { SVG: ['svg'] }
        });
        if (target) {
          await fs.promises.writeFile(target.fsPath, m.svg, 'utf8');
          vscode.window.showInformationMessage(`hBD: diagrama guardado en ${target.fsPath}`);
        }
      }
    });
  }
}
