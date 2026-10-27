import * as vscode from 'vscode';
import { format as formatSql } from 'sql-formatter';
import { ConnectionManager } from '../connectionManager';
import { BaseDriver } from '../drivers';
import { SqlDialect } from '../drivers/types';
import { QueryHistory } from '../history';
import { firstKeyword, splitSql, SqlStatement, statementAt, stripLeadingComments } from '../sql/splitter';
import { normalizeRows } from '../util/values';
import { ResultsView, ResultTab } from '../views/resultsView';
import { findParams, substituteParams } from './params';

export interface EditorAssoc {
  connId: string;
  database?: string;
}

const ASSOC_KEY = 'hbd.editorAssoc';
const DDL_KEYWORDS = new Set(['create', 'alter', 'drop', 'rename', 'truncate', 'comment']);

export class SqlEditorManager implements vscode.Disposable {
  private assoc: Map<string, EditorAssoc>;
  private paramValues = new Map<string, string>();
  private disposables: vscode.Disposable[] = [];
  private sbConn: vscode.StatusBarItem;
  private sbTx: vscode.StatusBarItem;
  private sbCommit: vscode.StatusBarItem;
  private sbRollback: vscode.StatusBarItem;
  private readonly _onDidRunDDL = new vscode.EventEmitter<string>();
  readonly onDidRunDDL = this._onDidRunDDL.event;
  private readonly lensEmitter = new vscode.EventEmitter<void>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly cm: ConnectionManager,
    private readonly results: ResultsView,
    private readonly history: QueryHistory,
    private readonly log: vscode.OutputChannel
  ) {
    this.assoc = new Map(Object.entries(ctx.workspaceState.get<Record<string, EditorAssoc>>(ASSOC_KEY, {})));
    this.sbConn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.sbConn.command = 'hbd.selectConnection';
    this.sbTx = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.sbTx.command = 'hbd.toggleAutoCommit';
    this.sbCommit = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    this.sbCommit.command = 'hbd.commit';
    this.sbCommit.text = '$(check) Commit';
    this.sbCommit.tooltip = 'Confirmar la transacción actual';
    this.sbRollback = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    this.sbRollback.command = 'hbd.rollback';
    this.sbRollback.text = '$(discard) Rollback';
    this.sbRollback.tooltip = 'Deshacer la transacción actual';

    this.disposables.push(
      this.sbConn, this.sbTx, this.sbCommit, this.sbRollback,
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
      cm.onDidChange(() => { this.updateStatus(); this.lensEmitter.fire(); }),
      cm.onDidChangeTx(() => this.updateStatus()),
      vscode.workspace.onDidCloseTextDocument(doc => {
        if (doc.isUntitled) this.assoc.delete(doc.uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('hbd.codeLens')) this.lensEmitter.fire(); }),
      vscode.languages.registerCodeLensProvider({ language: 'sql' }, {
        onDidChangeCodeLenses: this.lensEmitter.event,
        provideCodeLenses: doc => this.provideLenses(doc)
      }),
      vscode.languages.registerDocumentFormattingEditProvider({ language: 'sql' }, {
        provideDocumentFormattingEdits: doc => {
          const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
          return [vscode.TextEdit.replace(full, this.format(doc.getText(), doc))];
        }
      }),
      vscode.languages.registerDocumentRangeFormattingEditProvider({ language: 'sql' }, {
        provideDocumentRangeFormattingEdits: (doc, range) => [vscode.TextEdit.replace(range, this.format(doc.getText(range), doc))]
      })
    );
    this.updateStatus();
  }

  // ------------------------------------------------------------ asociación editor ↔ conexión
  getAssoc(doc: vscode.TextDocument): EditorAssoc | undefined {
    const a = this.assoc.get(doc.uri.toString());
    if (a && this.cm.get(a.connId)) return a;
    return undefined;
  }

  async setAssoc(doc: vscode.TextDocument, a: EditorAssoc): Promise<void> {
    this.assoc.set(doc.uri.toString(), a);
    if (!doc.isUntitled) {
      const persisted = Object.fromEntries([...this.assoc.entries()].filter(([k]) => !k.startsWith('untitled:')));
      await this.ctx.workspaceState.update(ASSOC_KEY, persisted);
    }
    this.updateStatus();
    this.lensEmitter.fire();
  }

  dialectFor(doc: vscode.TextDocument): SqlDialect | undefined {
    const a = this.getAssoc(doc);
    if (!a) return undefined;
    const d = this.cm.get(a.connId)?.driver;
    return d === 'postgres' ? 'postgresql' : d === 'mssql' ? 'transactsql' : d === 'sqlite' ? 'sqlite' : d === 'mariadb' ? 'mariadb' : d ? 'mysql' : undefined;
  }

  async newEditor(connId?: string, database?: string, content = ''): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
    if (connId) await this.setAssoc(doc, { connId, database });
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    if (content) {
      const end = doc.positionAt(content.length);
      ed.selection = new vscode.Selection(end, end);
    }
    return ed;
  }

  async selectConnection(doc?: vscode.TextDocument): Promise<EditorAssoc | undefined> {
    const list = this.cm.list();
    if (!list.length) {
      const c = await vscode.window.showInformationMessage('No hay conexiones configuradas.', 'Nueva conexión');
      if (c) vscode.commands.executeCommand('hbd.addConnection');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(list.map(c => ({
      label: `${this.cm.isConnected(c.id) ? '$(database)' : '$(server)'} ${c.name}`,
      description: c.driver + (c.database ? ` · ${c.database}` : ''),
      id: c.id
    })), { placeHolder: 'Seleccione la conexión para este editor' });
    if (!pick) return undefined;
    let database: string | undefined;
    try {
      const driver = await this.cm.getDriver(pick.id);
      const dbs = await driver.listDatabases();
      if (dbs.length > 1) {
        const def = driver.defaultDatabase();
        const p = await vscode.window.showQuickPick(
          dbs.map(d => ({ label: d, description: d === def ? '(predeterminada)' : undefined })),
          { placeHolder: 'Base de datos activa' });
        database = p?.label ?? def;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`hBD: ${e?.message ?? e}`);
      return undefined;
    }
    const a = { connId: pick.id, database };
    if (doc) await this.setAssoc(doc, a);
    return a;
  }

  private async resolve(doc: vscode.TextDocument): Promise<{ a: EditorAssoc; driver: BaseDriver } | undefined> {
    let a = this.getAssoc(doc);
    if (!a) {
      const connected = this.cm.connectedIds();
      if (connected.length === 1 && this.cm.list().length === 1) {
        a = { connId: connected[0] };
        await this.setAssoc(doc, a);
      } else {
        a = await this.selectConnection(doc);
      }
    }
    if (!a) return undefined;
    const driver = await this.cm.getDriver(a.connId);
    this.updateStatus();
    return { a, driver };
  }

  // ------------------------------------------------------------ ejecución
  private statements(doc: vscode.TextDocument): SqlStatement[] {
    const blank = vscode.workspace.getConfiguration('hbd').get<boolean>('blankLineDelimiter', true);
    return splitSql(doc.getText(), this.dialectFor(doc) ?? 'postgresql', { blankLineDelimiter: blank });
  }

  async runStatement(editor = vscode.window.activeTextEditor): Promise<void> {
    if (!editor) return;
    const doc = editor.document;
    let sqls: string[];
    if (!editor.selection.isEmpty) {
      const text = doc.getText(editor.selection);
      const blank = vscode.workspace.getConfiguration('hbd').get<boolean>('blankLineDelimiter', true);
      const parts = splitSql(text, this.dialectFor(doc) ?? 'postgresql', { blankLineDelimiter: blank });
      sqls = parts.length > 1 ? parts.map(p => p.text) : [text.trim().replace(/;\s*$/, '')];
    } else {
      const stmts = this.statements(doc);
      const st = statementAt(stmts, doc.offsetAt(editor.selection.active));
      if (!st) { vscode.window.showInformationMessage('hBD: no hay ninguna sentencia para ejecutar.'); return; }
      this.flash(editor, st);
      sqls = [st.text];
    }
    await this.execute(doc, sqls, sqls.length > 1 ? 'script' : 'single');
  }

  async runStatementAt(uri: vscode.Uri, start: number, end: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText(new vscode.Range(doc.positionAt(start), doc.positionAt(end))).trim();
    const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
    if (editor) this.flash(editor, { text, start, end });
    await this.execute(doc, [text], 'single');
  }

  async runScript(editor = vscode.window.activeTextEditor): Promise<void> {
    if (!editor) return;
    const doc = editor.document;
    let stmts = this.statements(doc);
    if (!editor.selection.isEmpty) {
      const s = doc.offsetAt(editor.selection.start), e = doc.offsetAt(editor.selection.end);
      const text = doc.getText(editor.selection);
      stmts = splitSql(text, this.dialectFor(doc) ?? 'postgresql', {
        blankLineDelimiter: vscode.workspace.getConfiguration('hbd').get<boolean>('blankLineDelimiter', true)
      }).map(x => ({ ...x, start: x.start + s, end: Math.min(e, x.end + s) }));
    }
    if (!stmts.length) return;
    await this.execute(doc, stmts.map(s => s.text), 'script');
  }

  async explain(editor = vscode.window.activeTextEditor): Promise<void> {
    if (!editor) return;
    const doc = editor.document;
    let sql: string | undefined;
    if (!editor.selection.isEmpty) sql = doc.getText(editor.selection).trim().replace(/;\s*$/, '');
    else sql = statementAt(this.statements(doc), doc.offsetAt(editor.selection.active))?.text;
    if (!sql) return;
    await this.execute(doc, [sql], 'explain');
  }

  async explainAt(uri: vscode.Uri, start: number, end: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const sql = doc.getText(new vscode.Range(doc.positionAt(start), doc.positionAt(end))).trim();
    if (sql) await this.execute(doc, [sql], 'explain');
  }

  /** Ejecuta SQL arbitrario contra una conexión (desde el explorador, historial, etc.). */
  async runOn(connId: string, database: string | undefined, sqls: string[], title?: string): Promise<void> {
    const driver = await this.cm.getDriver(connId);
    await this.runWith(driver, connId, database, sqls, sqls.length > 1 ? 'script' : 'single', title);
  }

  private flash(editor: vscode.TextEditor, st: SqlStatement): void {
    const deco = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground') });
    const doc = editor.document;
    editor.setDecorations(deco, [new vscode.Range(doc.positionAt(st.start), doc.positionAt(Math.min(st.end, st.start + st.text.length)))]);
    setTimeout(() => deco.dispose(), 450);
  }

  private async execute(doc: vscode.TextDocument, sqls: string[], mode: 'single' | 'script' | 'explain'): Promise<void> {
    let r: { a: EditorAssoc; driver: BaseDriver } | undefined;
    try {
      r = await this.resolve(doc);
    } catch (e: any) {
      vscode.window.showErrorMessage(`hBD: ${e?.message ?? e}`);
      return;
    }
    if (!r) return;
    await this.runWith(r.driver, r.a.connId, r.a.database, sqls, mode);
  }

  private async runWith(driver: BaseDriver, connId: string, database: string | undefined, sqls: string[], mode: 'single' | 'script' | 'explain', title?: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('hbd');
    const maxRows = cfg.get<number>('maxRows', 1000);
    const stopOnError = cfg.get<boolean>('script.stopOnError', true);
    const conn = this.cm.get(connId)!;

    // Parámetros
    if (cfg.get<boolean>('parameters.enabled', true)) {
      const all = sqls.map(s => findParams(s));
      const names = [...new Set(all.flat().map(p => p.name))];
      if (names.length) {
        const values = new Map<string, string>();
        for (const name of names) {
          const v = await vscode.window.showInputBox({
            prompt: `Valor para el parámetro ${name}`,
            placeHolder: 'Se inserta tal cual en el SQL (use comillas para texto, p. ej. \'abc\')',
            value: this.paramValues.get(name) ?? '',
            ignoreFocusOut: true
          });
          if (v === undefined) return;
          values.set(name, v);
          this.paramValues.set(name, v);
        }
        sqls = sqls.map((s, i) => substituteParams(s, all[i], values));
      }
    }

    // Confirmación de sentencias peligrosas
    if (cfg.get<boolean>('confirmDangerous', true) && mode !== 'explain') {
      const danger = sqls.filter(isDangerous);
      if (danger.length) {
        const preview = danger.slice(0, 3).map(s => '• ' + s.replace(/\s+/g, ' ').slice(0, 120)).join('\n');
        const ok = await vscode.window.showWarningMessage(
          `Va a ejecutar ${danger.length} sentencia(s) potencialmente destructiva(s) en "${conn.name}":\n\n${preview}`,
          { modal: true }, 'Ejecutar');
        if (ok !== 'Ejecutar') return;
      }
    }

    this.results.setExportContext({ quoteIdent: s => driver.quoteIdent(s), literal: v => driver.literal(v) });
    await this.results.beginRun(sqls[0] ?? '', true);
    const stats: { sql: string; ms: number; affected?: number; rows?: number; error?: string }[] = [];
    let anyResultTab = false;
    let ranDDL = false;
    const t0 = Date.now();
    for (let i = 0; i < sqls.length; i++) {
      const sql = sqls[i];
      const label = title ?? shortTitle(sql, i);
      try {
        const res = mode === 'explain' ? await driver.explain(sql, database) : await driver.execute(sql, database, maxRows);
        if (DDL_KEYWORDS.has(firstKeyword(sql))) ranDDL = true;
        this.log.appendLine(`[${new Date().toLocaleTimeString()}] ${conn.name}${database ? '/' + database : ''} (${res.durationMs} ms) ${oneLine(sql)}`);
        stats.push({ sql, ms: res.durationMs, affected: res.affectedRows, rows: res.columns.length ? res.rows.length : undefined });
        await this.history.add({ sql, connId, connName: conn.name, database, duration: res.durationMs, rows: res.columns.length ? res.rows.length : res.affectedRows });
        if (res.columns.length) {
          anyResultTab = true;
          this.results.addTab({
            title: mode === 'explain' ? `Plan: ${label}` : label,
            sql,
            columns: res.columns,
            rows: normalizeRows(res.rows),
            duration: res.durationMs,
            truncated: res.truncated,
            message: res.message,
            table: guessTable(sql)
          });
        } else if (mode !== 'script') {
          anyResultTab = true;
          this.results.addTab({
            title: label,
            sql,
            duration: res.durationMs,
            affected: res.affectedRows,
            message: `${res.message ? res.message + '\n' : ''}Sentencia ejecutada correctamente.${res.affectedRows !== undefined ? `\nFilas afectadas: ${res.affectedRows}` : ''}\nTiempo: ${res.durationMs} ms${driver.autoCommit ? '' : '\n(Transacción manual: recuerde hacer Commit)'}`
          });
        }
      } catch (e: any) {
        const msg = errorText(e);
        this.log.appendLine(`[${new Date().toLocaleTimeString()}] ERROR ${conn.name}: ${msg}\n    ${oneLine(sql)}`);
        stats.push({ sql, ms: 0, error: msg });
        await this.history.add({ sql, connId, connName: conn.name, database, error: msg });
        anyResultTab = true;
        this.results.addTab({ title: `Error: ${label}`, sql, error: `${msg}\n\n${sql}` });
        if (mode === 'script' && stopOnError) break;
      }
    }
    if (mode === 'script' && sqls.length > 1) {
      const total = Date.now() - t0;
      const errors = stats.filter(s => s.error).length;
      this.results.addTab({
        title: 'Estadísticas',
        columns: [{ name: '#' }, { name: 'Sentencia' }, { name: 'Filas' }, { name: 'Afectadas' }, { name: 'ms' }, { name: 'Error' }],
        rows: stats.map((s, i) => [i + 1, oneLine(s.sql).slice(0, 200), s.rows ?? null, s.affected ?? null, s.ms, s.error ?? null]),
        duration: total,
        message: `${stats.length} de ${sqls.length} sentencias ejecutadas, ${errors} con error`
      });
    } else if (!anyResultTab) {
      this.results.addTab({ title: 'Resultado', message: 'Sin resultados.' });
    }
    this.results.done();
    this.cm.fireTxChange(connId);
    if (ranDDL) this._onDidRunDDL.fire(connId);
  }

  // ------------------------------------------------------------ transacciones
  private activeDriver(): { driver: BaseDriver; connId: string } | undefined {
    const ed = vscode.window.activeTextEditor;
    const a = ed && ed.document.languageId === 'sql' ? this.getAssoc(ed.document) : undefined;
    const connId = a?.connId ?? (this.cm.connectedIds().length === 1 ? this.cm.connectedIds()[0] : undefined);
    const driver = connId ? this.cm.connectedDriver(connId) : undefined;
    return driver && connId ? { driver, connId } : undefined;
  }

  async toggleAutoCommit(): Promise<void> {
    const d = this.activeDriver();
    if (!d) { vscode.window.showInformationMessage('hBD: no hay una conexión activa para este editor.'); return; }
    await d.driver.setAutoCommit(!d.driver.autoCommit);
    vscode.window.setStatusBarMessage(`hBD: ${d.driver.autoCommit ? 'auto-commit activado' : 'modo transacción manual'}`, 3000);
    this.cm.fireTxChange(d.connId);
  }

  async commit(): Promise<void> {
    const d = this.activeDriver();
    if (!d) return;
    try {
      await d.driver.commit();
      vscode.window.setStatusBarMessage('hBD: commit realizado', 3000);
    } catch (e: any) {
      vscode.window.showErrorMessage(`hBD: ${errorText(e)}`);
    }
    this.cm.fireTxChange(d.connId);
  }

  async rollback(): Promise<void> {
    const d = this.activeDriver();
    if (!d) return;
    try {
      await d.driver.rollback();
      vscode.window.setStatusBarMessage('hBD: rollback realizado', 3000);
    } catch (e: any) {
      vscode.window.showErrorMessage(`hBD: ${errorText(e)}`);
    }
    this.cm.fireTxChange(d.connId);
  }

  updateStatus(): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'sql') {
      this.sbConn.hide(); this.sbTx.hide(); this.sbCommit.hide(); this.sbRollback.hide();
      return;
    }
    const a = this.getAssoc(ed.document);
    const conn = a ? this.cm.get(a.connId) : undefined;
    if (!conn) {
      this.sbConn.text = '$(database) hBD: sin conexión';
      this.sbConn.tooltip = 'Seleccionar conexión para este editor';
      this.sbConn.backgroundColor = undefined;
      this.sbConn.show();
      this.sbTx.hide(); this.sbCommit.hide(); this.sbRollback.hide();
      return;
    }
    const driver = this.cm.connectedDriver(conn.id);
    this.sbConn.text = `$(database) ${conn.name}${a?.database ? ' / ' + a.database : ''}${driver ? '' : ' (desconectado)'}`;
    this.sbConn.tooltip = `Conexión activa del editor (${conn.driver}). Clic para cambiar.`;
    this.sbConn.backgroundColor = conn.readOnly ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.sbConn.show();
    if (!driver) { this.sbTx.hide(); this.sbCommit.hide(); this.sbRollback.hide(); return; }
    if (driver.autoCommit) {
      this.sbTx.text = '$(sync) Auto-commit';
      this.sbTx.tooltip = 'Modo auto-commit. Clic para cambiar a transacción manual.';
      this.sbTx.backgroundColor = undefined;
      this.sbCommit.hide(); this.sbRollback.hide();
    } else {
      this.sbTx.text = `$(git-commit) Manual${driver.hasOpenTransaction ? ' (tx abierta)' : ''}`;
      this.sbTx.tooltip = 'Modo de transacción manual. Clic para volver a auto-commit (se confirmará la transacción).';
      this.sbTx.backgroundColor = driver.hasOpenTransaction ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      this.sbCommit.show(); this.sbRollback.show();
    }
    this.sbTx.show();
  }

  // ------------------------------------------------------------ formato y codelens
  format(text: string, doc?: vscode.TextDocument): string {
    const cfg = vscode.workspace.getConfiguration('hbd');
    const lang = (doc && this.dialectFor(doc)) ?? 'sql';
    try {
      return formatSql(text, {
        language: lang as any,
        keywordCase: cfg.get<'upper' | 'lower' | 'preserve'>('format.keywordCase', 'upper'),
        tabWidth: cfg.get<number>('format.tabWidth', 2),
        linesBetweenQueries: 2
      });
    } catch (e: any) {
      vscode.window.showWarningMessage(`hBD: no se pudo formatear: ${e?.message ?? e}`);
      return text;
    }
  }

  async formatCommand(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const doc = ed.document;
    const range = ed.selection.isEmpty ? new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)) : ed.selection;
    const out = this.format(doc.getText(range), doc);
    await ed.edit(b => b.replace(range, out));
  }

  private provideLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('hbd').get<boolean>('codeLens.enabled', true)) return [];
    if (doc.lineCount > 5000) return [];
    const stmts = this.statements(doc);
    const lenses: vscode.CodeLens[] = [];
    const a = this.getAssoc(doc);
    const connName = a ? this.cm.get(a.connId)?.name : undefined;
    for (const s of stmts.slice(0, 500)) {
      const pos = doc.positionAt(s.start);
      const range = new vscode.Range(pos, pos);
      lenses.push(new vscode.CodeLens(range, { title: '▶ Ejecutar', command: 'hbd.runStatementAt', arguments: [doc.uri, s.start, s.start + s.text.length] }));
      if (/^\s*(select|with)\b/i.test(stripLeadingComments(s.text))) {
        lenses.push(new vscode.CodeLens(range, { title: 'Explain', command: 'hbd.explain', arguments: [doc.uri, s.start, s.start + s.text.length] }));
      }
    }
    if (stmts.length && lenses.length) {
      lenses.unshift(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: connName ? `$(database) ${connName}${a?.database ? ' / ' + a.database : ''}` : '$(database) Seleccionar conexión',
        command: 'hbd.selectConnection',
        arguments: []
      }));
    }
    return lenses;
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this._onDidRunDDL.dispose();
    this.lensEmitter.dispose();
  }
}

export function isDangerous(sql: string): boolean {
  const kw = firstKeyword(sql);
  if (kw === 'drop' || kw === 'truncate') return true;
  if (kw === 'delete' || kw === 'update') {
    const s = stripLeadingComments(sql).replace(/'(?:[^']|'')*'/g, "''");
    return !/\bwhere\b/i.test(s);
  }
  return false;
}

export function errorText(e: any): string {
  if (!e) return 'Error desconocido';
  const parts = [e.message ?? String(e)];
  if (e.detail) parts.push(`Detalle: ${e.detail}`);
  if (e.hint) parts.push(`Sugerencia: ${e.hint}`);
  if (e.position) parts.push(`Posición: ${e.position}`);
  if (e.code && typeof e.code === 'string' && !parts[0].includes(e.code)) parts.push(`Código: ${e.code}`);
  if (e.originalError?.info?.message && !parts[0].includes(e.originalError.info.message)) parts.push(e.originalError.info.message);
  return parts.join('\n');
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function shortTitle(sql: string, i: number): string {
  const s = oneLine(stripLeadingComments(sql));
  const m = /^select\b[\s\S]*?\bfrom\s+([\w."`\[\]]+)/i.exec(s);
  if (m) return m[1].replace(/["`\[\]]/g, '');
  return s.length > 28 ? s.slice(0, 28) + '…' : s || `Resultado ${i + 1}`;
}

function guessTable(sql: string): string | undefined {
  const m = /^\s*select\b[\s\S]*?\bfrom\s+([\w."`\[\]]+)/i.exec(stripLeadingComments(sql));
  return m ? m[1] : undefined;
}
