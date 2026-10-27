import * as vscode from 'vscode';
import { ExportContext } from '../util/exporter';
import { CellValue } from '../util/values';
import { buildHtml, exportRowsToFile, handleGridMessage } from './webview';

export interface ResultTab {
  title: string;
  sql?: string;
  columns?: { name: string; type?: string }[];
  rows?: CellValue[][];
  duration?: number;
  affected?: number;
  error?: string;
  message?: string;
  truncated?: boolean;
  table?: string;
}

/** Panel inferior con los resultados de las consultas (pestañas múltiples). */
export class ResultsView implements vscode.WebviewViewProvider {
  static readonly id = 'hbd.results';
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private queue: any[] = [];
  private exportCtx: ExportContext = {};

  constructor(private readonly extUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media')] };
    view.webview.html = buildHtml(view.webview, this.extUri, {
      title: 'Resultados',
      scripts: ['grid.js', 'results.js'],
      body: `
<div id="tabs" class="tabs"></div>
<div class="toolbar">
  <input id="filter" type="search" placeholder="Filtrar filas…" style="width:200px">
  <button id="btnRecord" title="Alternar vista de registro (fila vertical)">Registro</button>
  <button id="btnPanel" title="Panel de valor de la celda">Valor</button>
  <button id="btnExport" title="Exportar resultado">Exportar…</button>
  <button id="btnSql" title="Abrir la consulta en un editor">SQL</button>
  <button id="btnPin" title="Fijar pestaña (no se reemplaza en la próxima ejecución). También: doble clic en la pestaña">Fijar</button>
  <button id="btnCloseAll" title="Cerrar pestañas no fijadas">Cerrar todo</button>
  <span class="grow"></span>
  <span id="status" class="status"></span>
</div>
<div id="gridwrap" style="flex:1;display:flex;min-height:0"><div id="grid" style="flex:1;display:flex;min-height:0"></div></div>
<div id="msg" class="msg hidden"></div>
<div id="empty" class="placeholder">Ejecute una consulta (Ctrl+Enter) para ver resultados aquí.</div>`
    });
    view.webview.onDidReceiveMessage(async msg => {
      try {
        if (msg.type === 'ready') {
          this.ready = true;
          for (const m of this.queue) view.webview.postMessage(m);
          this.queue = [];
          return;
        }
        if (await handleGridMessage(msg, this.exportCtx)) return;
        if (msg.type === 'export') {
          await exportRowsToFile(msg.columns, msg.rows, msg.tableName || msg.title || 'resultado',
            { ...this.exportCtx, tableName: msg.tableName || this.exportCtx.tableName });
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`hBD: ${e?.message ?? e}`);
      }
    });
    view.onDidDispose(() => { this.view = undefined; this.ready = false; });
  }

  setExportContext(ctx: ExportContext): void {
    this.exportCtx = ctx;
  }

  private post(msg: any): void {
    if (this.view && this.ready) this.view.webview.postMessage(msg);
    else this.queue.push(msg);
  }

  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(true);
      return;
    }
    const hadEditorFocus = !!vscode.window.activeTextEditor;
    await vscode.commands.executeCommand(`${ResultsView.id}.focus`);
    // devolver el foco al editor SQL para poder seguir escribiendo / ejecutando
    if (hadEditorFocus) await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }

  async beginRun(sql: string, reset = true): Promise<void> {
    await this.reveal();
    this.post({ type: 'running', sql, reset });
  }

  addTab(tab: ResultTab): void {
    this.post({ type: 'addTab', tab });
  }

  done(): void {
    this.post({ type: 'done' });
  }
}
