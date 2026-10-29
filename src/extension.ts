import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionManager, STATE_KEY, syncEnabled } from './connectionManager';
import { BaseDriver } from './drivers';
import { ConnectionConfig, DRIVER_LABELS, KIND_LABELS, ObjectRef } from './drivers/types';
import { MetadataCache, SqlCompletionProvider } from './editor/completion';
import { errorText, SqlEditorManager } from './editor/sqlEditor';
import { ConnectionTree, DbNode } from './explorer/tree';
import { HISTORY_KEY, HistoryItem, QueryHistory } from './history';
import { decryptDbeaverCredentials, findDbeaverConfigs, isDbeaverConfig, parseDbeaver } from './importers/dbeaver';
import { detectDelimiter, parseCsv } from './util/csv';
import { formatData } from './util/exporter';
import { normalizeRows } from './util/values';
import { ConnectionForm } from './views/connectionForm';
import { ErDiagramPanel } from './views/erDiagram';
import { ResultsView } from './views/resultsView';
import { TableEditorPanel, TableTab } from './views/tableEditor';
import { askExportTarget, notifyExported, pickExportFormat } from './views/webview';

export function activate(ctx: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('hBD');
  const cm = new ConnectionManager(ctx, log);
  const tree = new ConnectionTree(cm);
  const history = new QueryHistory(ctx);
  const results = new ResultsView(ctx.extensionUri);
  const sqlm = new SqlEditorManager(ctx, cm, results, history, log);
  const cache = new MetadataCache();

  const treeView = vscode.window.createTreeView('hbd.connections', { treeDataProvider: tree, showCollapseAll: true, dragAndDropController: tree, canSelectMany: true });
  ctx.subscriptions.push(
    log, cm, sqlm, treeView,
    vscode.window.createTreeView('hbd.history', { treeDataProvider: history }),
    vscode.window.registerWebviewViewProvider(ResultsView.id, results, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.languages.registerCompletionItemProvider({ language: 'sql' }, new SqlCompletionProvider(cm, sqlm, cache), '.'),
    cm.onDidChange(id => { if (id && !cm.isConnected(id)) cache.clear(id); }),
    sqlm.onDidRunDDL(id => { cache.clear(id); tree.refresh(); })
  );

  // Sincronización entre equipos (Sincronización de configuración de VS Code).
  // Las contraseñas viven en SecretStorage, que nunca se sincroniza.
  const applySync = () => {
    const keys: string[] = [];
    if (syncEnabled()) keys.push(STATE_KEY);
    if (vscode.workspace.getConfiguration('hbd').get<boolean>('history.sync', false)) keys.push(HISTORY_KEY);
    ctx.globalState.setKeysForSync(keys);
  };
  applySync();
  const pullSynced = () => {
    cm.reloadIfChanged().catch(e => log.appendLine(`Error al recargar conexiones: ${errorText(e)}`));
    history.reload();
  };
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('hbd.syncConnections') || e.affectsConfiguration('hbd.history.sync')) applySync();
    }),
    // VS Code no avisa cuando llega estado sincronizado: se revisa al volver a la ventana y cada minuto
    vscode.window.onDidChangeWindowState(s => { if (s.focused) pullSynced(); }),
    treeView.onDidChangeVisibility(v => { if (v.visible) pullSynced(); })
  );
  const timer = setInterval(pullSynced, 60_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });

  const openTable = (connId: string, ref: ObjectRef, tab: TableTab = 'data') =>
    TableEditorPanel.open(ctx.extensionUri, cm, connId, ref, tab, () => cache.clear(connId));

  /** Registra un comando con manejo de errores uniforme. */
  const reg = (id: string, fn: (...args: any[]) => any) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (e: any) {
        const msg = errorText(e);
        if (!/cancelada/i.test(msg)) vscode.window.showErrorMessage(`hBD: ${msg}`);
        log.appendLine(`[${new Date().toLocaleTimeString()}] ERROR (${id}): ${msg}`);
      }
    }));

  const requireNode = (n: unknown): DbNode => {
    if (n instanceof DbNode) return n;
    const sel = treeView.selection[0];
    if (sel) return sel;
    throw new Error('Seleccione un elemento en el explorador de hBD.');
  };

  const requireObj = (n: unknown): { node: DbNode; ref: ObjectRef } => {
    const node = requireNode(n);
    if (!node.data.obj) throw new Error('Seleccione una tabla u objeto en el explorador.');
    return { node, ref: node.data.obj };
  };

  const pickConnection = async (placeHolder: string): Promise<string | undefined> => {
    const list = cm.list();
    if (!list.length) throw new Error('No hay conexiones configuradas.');
    if (list.length === 1) return list[0].id;
    const p = await vscode.window.showQuickPick(list.map(c => ({ label: c.name, description: DRIVER_LABELS[c.driver], id: c.id })), { placeHolder });
    return p?.id;
  };

  const connIdOf = async (n: unknown, placeHolder = 'Seleccione una conexión'): Promise<string | undefined> => {
    if (n instanceof DbNode && n.data.connId) return n.data.connId;
    const sel = treeView.selection[0];
    if (sel?.data.connId) return sel.data.connId;
    return pickConnection(placeHolder);
  };

  // ---------------------------------------------------------------- conexiones
  reg('hbd.addConnection', () => ConnectionForm.open(ctx.extensionUri, cm));
  reg('hbd.editConnection', (n?: DbNode) => {
    const c = cm.get(requireNode(n).data.connId);
    if (c) ConnectionForm.open(ctx.extensionUri, cm, c);
  });
  reg('hbd.deleteConnection', async (n?: DbNode) => {
    const c = cm.get(requireNode(n).data.connId);
    if (!c) return;
    const ok = await vscode.window.showWarningMessage(`¿Eliminar la conexión "${c.name}"?`, { modal: true }, 'Eliminar');
    if (ok === 'Eliminar') await cm.remove(c.id);
  });
  reg('hbd.duplicateConnection', async (n?: DbNode) => { await cm.duplicate(requireNode(n).data.connId); });
  reg('hbd.connect', async (n?: DbNode) => {
    const id = await connIdOf(n);
    if (id) { await cm.getDriver(id); tree.refresh(); }
  });
  reg('hbd.disconnect', async (n?: DbNode) => {
    const id = await connIdOf(n);
    if (id) { await cm.disconnect(id); cache.clear(id); }
  });
  reg('hbd.disconnectAll', async () => { await cm.disconnectAll(); cache.clear(); });
  reg('hbd.refresh', (n?: DbNode) => {
    const node = n instanceof DbNode ? n : undefined;
    cache.clear(node?.data.connId);
    tree.refresh(node);
  });
  reg('hbd.refreshAll', () => { cache.clear(); tree.refresh(); });
  reg('hbd.filterObjects', async (n?: DbNode) => {
    const id = await connIdOf(n);
    if (!id) return;
    const v = await vscode.window.showInputBox({ prompt: 'Mostrar solo objetos cuyo nombre contenga (vacío = quitar filtro)', value: tree.getFilter(id) ?? '' });
    if (v !== undefined) tree.setFilter(id, v.trim() || undefined);
  });
  reg('hbd.searchObjects', async (n?: DbNode) => {
    const id = await connIdOf(n, 'Conexión donde buscar');
    if (!id) return;
    const pattern = await vscode.window.showInputBox({ prompt: 'Buscar tablas, vistas, funciones… (parte del nombre)' });
    if (!pattern) return;
    const d = await cm.getDriver(id);
    const found = await d.searchObjects(pattern);
    if (!found.length) { vscode.window.showInformationMessage(`hBD: no se encontraron objetos con "${pattern}".`); return; }
    const pick = await vscode.window.showQuickPick(found.map(o => ({
      label: `${o.name}${o.signature !== undefined ? `(${o.signature})` : ''}`,
      description: `${KIND_LABELS[o.kind]} · ${[o.database, o.schema].filter(Boolean).join('.')}`,
      o
    })), { placeHolder: `${found.length} objeto(s) encontrados`, matchOnDescription: true });
    if (!pick) return;
    const o = pick.o;
    if (o.kind === 'table' || o.kind === 'view' || o.kind === 'matview') openTable(id, o);
    else await showDDL(id, o);
  });
  reg('hbd.exportConnections', async () => {
    const target = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] }, defaultUri: vscode.Uri.file('hbd-conexiones.json') });
    if (!target) return;
    const list = cm.list().map(c => ({ ...c, id: undefined }));
    await fs.promises.writeFile(target.fsPath, JSON.stringify(list, null, 2), 'utf8');
    vscode.window.showInformationMessage(`hBD: ${list.length} conexión(es) exportadas (sin contraseñas).`);
  });
  const importFromFile = async (file: string) => {
    let data: any;
    try {
      data = JSON.parse((await fs.promises.readFile(file, 'utf8')).replace(/^﻿/, ''));
    } catch (e: any) {
      throw new Error(`No se pudo leer ${path.basename(file)} como JSON: ${e?.message ?? e}`);
    }
    if (Array.isArray(data)) {
      const n = await cm.importConfigs(data as ConnectionConfig[]);
      vscode.window.showInformationMessage(`hBD: ${n} conexión(es) importadas.`);
      return;
    }
    if (!isDbeaverConfig(data)) {
      throw new Error('Formato no reconocido. Se admite el JSON exportado por hBD o el data-sources.json de DBeaver.');
    }
    // Credenciales de DBeaver (credentials-config.json en la misma carpeta)
    let creds: Record<string, any> | undefined;
    const credFile = path.join(path.dirname(file), 'credentials-config.json');
    if (fs.existsSync(credFile)) {
      const ans = await vscode.window.showInformationMessage(
        '¿Importar también los usuarios y contraseñas guardados en DBeaver?',
        { modal: true, detail: 'Se descifran de credentials-config.json y se guardan en el almacenamiento seguro de VS Code de este equipo (no se sincronizan).' },
        'Sí, importar credenciales', 'No, solo las conexiones');
      if (!ans) return;
      if (ans.startsWith('Sí')) {
        try {
          creds = decryptDbeaverCredentials(await fs.promises.readFile(credFile));
        } catch (e: any) {
          vscode.window.showWarningMessage(`hBD: no se pudieron descifrar las credenciales de DBeaver (¿contraseña maestra activada?). Se importan solo las conexiones. ${e?.message ?? ''}`);
        }
      }
    }
    const res = parseDbeaver(data, creds);
    for (const s of res.skipped) log.appendLine(`Importación DBeaver: se omite "${s.name}": ${s.reason}`);
    if (!res.items.length) {
      vscode.window.showWarningMessage(`hBD: no hay conexiones compatibles para importar${res.skipped.length ? ` (${res.skipped.length} omitidas, ver log)` : ''}.`);
      return;
    }
    const picks = await vscode.window.showQuickPick(res.items.map(it => {
      const c = it.config;
      const dup = !!c.sourceId && cm.hasSource(c.sourceId);
      return {
        label: c.name,
        description: `${DRIVER_LABELS[c.driver]} · ${c.driver === 'sqlite' ? c.filePath : `${c.host}${c.port ? ':' + c.port : ''}${c.database ? '/' + c.database : ''}`}`,
        detail: [c.user ? `usuario: ${c.user}` : undefined, it.password !== undefined ? 'con contraseña' : undefined, c.ssh ? 'túnel SSH' : undefined, dup ? 'ya importada antes' : undefined]
          .filter(Boolean).join(' · ') || undefined,
        picked: !dup,
        it
      };
    }), { canPickMany: true, placeHolder: `Conexiones de DBeaver a importar (${res.items.length} compatibles${res.skipped.length ? `, ${res.skipped.length} omitidas` : ''})`, matchOnDescription: true });
    if (!picks?.length) return;
    const n = await cm.importItems(picks.map(p => p.it));
    const withPwd = picks.filter(p => p.it.password !== undefined).length;
    vscode.window.showInformationMessage(
      `hBD: ${n} conexión(es) importadas desde DBeaver${creds ? `, ${withPwd} con contraseña` : ''}.${res.skipped.length ? ` ${res.skipped.length} omitidas (ver log).` : ''}`,
      ...(res.skipped.length ? ['Ver log'] : [])).then(c => { if (c) log.show(); });
  };

  reg('hbd.importConnections', async () => {
    const dbeaver = findDbeaverConfigs()[0];
    const pick = await vscode.window.showOpenDialog({
      filters: { JSON: ['json'] },
      canSelectMany: false,
      openLabel: 'Importar',
      defaultUri: dbeaver ? vscode.Uri.file(path.dirname(dbeaver)) : undefined
    });
    if (pick?.[0]) await importFromFile(pick[0].fsPath);
  });
  reg('hbd.importDbeaver', async () => {
    const found = findDbeaverConfigs();
    if (!found.length) {
      const c = await vscode.window.showInformationMessage('hBD: no se encontró la configuración de DBeaver en este equipo.', 'Buscar archivo…');
      if (c) await vscode.commands.executeCommand('hbd.importConnections');
      return;
    }
    let file = found[0];
    if (found.length > 1) {
      const p = await vscode.window.showQuickPick(found.map(f => ({ label: path.basename(path.dirname(path.dirname(f))), description: f, f })), { placeHolder: 'Proyecto de DBeaver' });
      if (!p) return;
      file = p.f;
    }
    await importFromFile(file);
  });
  reg('hbd.showSessions', async (n?: DbNode) => {
    const id = await connIdOf(n);
    if (!id) return;
    const d = await cm.getDriver(id);
    await sqlm.runOn(id, undefined, [d.sessionsSql()], 'Sesiones');
  });
  reg('hbd.serverInfo', async (n?: DbNode) => {
    const id = await connIdOf(n);
    if (!id) return;
    const d = await cm.getDriver(id);
    const c = d.config;
    const v = await d.version();
    vscode.window.showInformationMessage(`${c.name} (${DRIVER_LABELS[c.driver]})`, {
      modal: true,
      detail: `${v}\n\nHost: ${c.driver === 'sqlite' ? c.filePath : `${c.host}:${c.port}`}\nUsuario: ${c.user ?? '-'}\nBase predeterminada: ${d.defaultDatabase()}\nModo: ${d.autoCommit ? 'auto-commit' : 'transacción manual'}${c.readOnly ? '\nSolo lectura' : ''}${c.ssh?.enabled ? `\nTúnel SSH: ${c.ssh.user}@${c.ssh.host}` : ''}`
    });
  });
  reg('hbd.showLog', () => log.show());

  // ---------------------------------------------------------------- editor SQL
  reg('hbd.newSqlEditor', async (arg?: any) => {
    if (arg instanceof DbNode) {
      const db = arg.data.database;
      const d = await cm.getDriver(arg.data.connId);
      let content = '';
      if (arg.data.schema && d.config.driver === 'postgres') content = `SET search_path TO ${d.quoteIdent(arg.data.schema)};\n\n`;
      await sqlm.newEditor(arg.data.connId, db, content);
      return;
    }
    if (arg && typeof arg === 'object' && arg.connId) {
      await sqlm.newEditor(arg.connId, arg.database, arg.content ?? '');
      return;
    }
    const sel = treeView.selection[0];
    if (sel?.data.connId) { await sqlm.newEditor(sel.data.connId, sel.data.database); return; }
    const ed = await sqlm.newEditor();
    const connected = cm.connectedIds();
    if (connected.length === 1) await sqlm.setAssoc(ed.document, { connId: connected[0] });
    else if (cm.list().length) await sqlm.selectConnection(ed.document);
  });
  reg('hbd.selectConnection', async () => {
    const ed = vscode.window.activeTextEditor;
    if (ed) await sqlm.selectConnection(ed.document);
  });
  reg('hbd.runStatement', () => sqlm.runStatement());
  reg('hbd.runStatementAt', (uri: vscode.Uri, start: number, end: number) => sqlm.runStatementAt(uri, start, end));
  reg('hbd.runScript', () => sqlm.runScript());
  reg('hbd.explain', (uri?: unknown, start?: number, end?: number) =>
    uri instanceof vscode.Uri && start !== undefined && end !== undefined ? sqlm.explainAt(uri, start, end) : sqlm.explain());
  reg('hbd.formatSql', () => sqlm.formatCommand());
  reg('hbd.toggleAutoCommit', () => sqlm.toggleAutoCommit());
  reg('hbd.commit', () => sqlm.commit());
  reg('hbd.rollback', () => sqlm.rollback());

  // ---------------------------------------------------------------- historial
  reg('hbd.history.open', async (item?: HistoryItem) => {
    if (!item) return;
    const e = item.entry;
    await sqlm.newEditor(cm.get(e.connId) ? e.connId : undefined, e.database, e.sql);
  });
  reg('hbd.history.run', async (item?: HistoryItem) => {
    if (!item) return;
    const e = item.entry;
    if (!cm.get(e.connId)) throw new Error('La conexión de esta consulta ya no existe.');
    await sqlm.runOn(e.connId, e.database, [e.sql]);
  });
  reg('hbd.history.copy', async (item?: HistoryItem) => { if (item) await vscode.env.clipboard.writeText(item.entry.sql); });
  reg('hbd.history.delete', async (item?: HistoryItem) => { if (item) await history.remove(item.entry.id); });
  reg('hbd.history.clear', async () => {
    const ok = await vscode.window.showWarningMessage('¿Borrar todo el historial de consultas?', { modal: true }, 'Borrar');
    if (ok) await history.clear();
  });

  // ---------------------------------------------------------------- objetos
  const showDDL = async (connId: string, ref: ObjectRef) => {
    const d = await cm.getDriver(connId);
    const ddl = await d.getDDL(ref);
    await sqlm.newEditor(connId, ref.database, ddl);
  };

  const newEditorWith = (connId: string, database: string | undefined, content: string) => sqlm.newEditor(connId, database, content);

  reg('hbd.openTableData', (n?: DbNode) => { const { node, ref } = requireObj(n); openTable(node.data.connId, ref, 'data'); });
  reg('hbd.openTableProperties', (n?: DbNode) => { const { node, ref } = requireObj(n); openTable(node.data.connId, ref, 'props'); });
  reg('hbd.showDDL', async (n?: DbNode) => { const { node, ref } = requireObj(n); await showDDL(node.data.connId, ref); });

  reg('hbd.generateSelect', async (n?: DbNode) => {
    const { node, ref } = requireObj(n);
    const d = await cm.getDriver(node.data.connId);
    const cols = await d.listColumns(ref);
    const sql = `SELECT\n  ${cols.map(c => d.quoteIdent(c.name)).join(',\n  ')}\nFROM ${d.qualified(ref)};\n`;
    await newEditorWith(node.data.connId, ref.database, sql);
  });
  reg('hbd.generateInsert', async (n?: DbNode) => {
    const { node, ref } = requireObj(n);
    const d = await cm.getDriver(node.data.connId);
    const cols = (await d.listColumns(ref)).filter(c => !c.isAutoIncrement);
    const sql = `INSERT INTO ${d.qualified(ref)}\n  (${cols.map(c => d.quoteIdent(c.name)).join(', ')})\nVALUES\n  (${cols.map(c => sampleValue(c.dataType)).join(', ')});\n`;
    await newEditorWith(node.data.connId, ref.database, sql);
  });
  reg('hbd.generateUpdate', async (n?: DbNode) => {
    const { node, ref } = requireObj(n);
    const d = await cm.getDriver(node.data.connId);
    const cols = await d.listColumns(ref);
    const pk = cols.filter(c => c.isPrimaryKey);
    const rest = cols.filter(c => !c.isPrimaryKey);
    const keys = pk.length ? pk : cols.slice(0, 1);
    const sql = `UPDATE ${d.qualified(ref)}\nSET\n  ${rest.map(c => `${d.quoteIdent(c.name)} = ${sampleValue(c.dataType)}`).join(',\n  ')}\nWHERE ${keys.map(c => `${d.quoteIdent(c.name)} = ${sampleValue(c.dataType)}`).join(' AND ')};\n`;
    await newEditorWith(node.data.connId, ref.database, sql);
  });
  reg('hbd.generateDelete', async (n?: DbNode) => {
    const { node, ref } = requireObj(n);
    const d = await cm.getDriver(node.data.connId);
    const cols = await d.listColumns(ref);
    const keys = cols.filter(c => c.isPrimaryKey).length ? cols.filter(c => c.isPrimaryKey) : cols.slice(0, 1);
    const sql = `DELETE FROM ${d.qualified(ref)}\nWHERE ${keys.map(c => `${d.quoteIdent(c.name)} = ${sampleValue(c.dataType)}`).join(' AND ')};\n`;
    await newEditorWith(node.data.connId, ref.database, sql);
  });
  reg('hbd.newTableTemplate', async (n?: DbNode) => {
    const node = requireNode(n);
    const d = await cm.getDriver(node.data.connId);
    const db = node.data.database ?? d.defaultDatabase();
    await newEditorWith(node.data.connId, db, d.newTableTemplate(db, node.data.schema ?? d.defaultSchema()));
  });

  reg('hbd.countRows', async (n?: DbNode) => {
    const { node, ref } = requireObj(n);
    const d = await cm.getDriver(node.data.connId);
    const r = await d.execute(d.countSql(ref), ref.database);
    vscode.window.showInformationMessage(`hBD: ${d.qualified(ref)} tiene ${Number(r.rows[0]?.[0] ?? 0).toLocaleString()} fila(s).`);
  });

  reg('hbd.truncateTable', async (n?: DbNode) => {
    const { node, ref } = requireObj(n);
    const d = await cm.getDriver(node.data.connId);
    const sql = d.truncateSql(ref);
    const ok = await vscode.window.showWarningMessage(`¿Vaciar la tabla ${d.qualified(ref)}? Se eliminarán TODAS las filas.`, { modal: true, detail: sql }, 'Vaciar');
    if (ok !== 'Vaciar') return;
    await d.execute(sql, ref.database);
    cm.fireTxChange(node.data.connId);
    vscode.window.setStatusBarMessage(`hBD: tabla ${ref.name} vaciada`, 3000);
  });

  reg('hbd.dropObject', async (n?: DbNode) => {
    const node = requireNode(n);
    const d = await cm.getDriver(node.data.connId);
    let sql: string;
    let what: string;
    let runDb: string | undefined;
    if (node.data.type === 'database') {
      const db = node.data.database!;
      sql = d.dropDatabaseSql(db);
      what = `la base de datos ${db}`;
      runDb = d.config.driver === 'postgres' ? (db === 'postgres' ? 'template1' : 'postgres') : d.config.driver === 'mssql' ? 'master' : undefined;
    } else if (node.data.type === 'schema') {
      sql = d.dropSchemaSql(node.data.schema!);
      what = `el esquema ${node.data.schema}`;
      runDb = node.data.database;
    } else if (node.data.obj) {
      sql = d.dropSql(node.data.obj);
      what = `${KIND_LABELS[node.data.obj.kind].toLowerCase()}: ${d.qualified(node.data.obj)}`;
      runDb = node.data.obj.database;
    } else return;
    const ok = await vscode.window.showWarningMessage(`¿Eliminar ${what}? Esta acción no se puede deshacer.`, { modal: true, detail: sql }, 'Eliminar');
    if (ok !== 'Eliminar') return;
    // no se puede borrar una base con sesiones propias abiertas
    if (node.data.type === 'database') await d.releaseDatabase(node.data.database!);
    await d.execute(sql, runDb);
    cm.fireTxChange(node.data.connId);
    cache.clear(node.data.connId);
    tree.refresh();
  });

  reg('hbd.createDatabase', async (n?: DbNode) => {
    const id = await connIdOf(n);
    if (!id) return;
    const d = await cm.getDriver(id);
    if (!d.caps.createDatabase) throw new Error('Este motor no permite crear bases de datos desde aquí.');
    const name = await vscode.window.showInputBox({ prompt: 'Nombre de la nueva base de datos' });
    if (!name) return;
    await d.execute(d.createDatabaseSql(name));
    tree.refresh();
  });
  reg('hbd.createSchema', async (n?: DbNode) => {
    const node = requireNode(n);
    const d = await cm.getDriver(node.data.connId);
    if (!d.caps.createSchema) throw new Error('Este motor no tiene esquemas.');
    const name = await vscode.window.showInputBox({ prompt: 'Nombre del nuevo esquema' });
    if (!name) return;
    await d.execute(d.createSchemaSql(name), node.data.database);
    tree.refresh();
  });

  reg('hbd.copyName', async (n?: DbNode) => {
    const node = requireNode(n);
    const d = cm.connectedDriver(node.data.connId);
    let text = node.data.name ?? String(node.label ?? '');
    if (node.data.type === 'object' && node.data.obj && d) text = d.qualified(node.data.obj);
    else if (node.data.type === 'column' && d) text = d.quoteIdent(node.data.name!);
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`hBD: copiado "${text}"`, 2000);
  });

  reg('hbd.erDiagram', (n?: DbNode) => {
    const node = requireNode(n);
    const focus = node.data.type === 'object' ? node.data.obj?.name : undefined;
    const database = node.data.database ?? node.data.obj?.database;
    if (!database) throw new Error('Seleccione una base de datos, esquema o tabla.');
    ErDiagramPanel.open(ctx.extensionUri, cm, node.data.connId, database, node.data.schema, focus, ref => openTable(node.data.connId, ref));
  });

  reg('hbd.exportTable', async (n?: DbNode) => {
    const { node, ref } = requireObj(n);
    const d = await cm.getDriver(node.data.connId);
    const fmt = await pickExportFormat();
    if (!fmt) return;
    const target = await askExportTarget(ref.name, fmt.id);
    if (!target) return;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `hBD: exportando ${ref.name}…` },
      () => d.execute(d.selectAllSql(ref), ref.database));
    const text = formatData(fmt.id, r.columns.map(c => c.name), normalizeRows(r.rows),
      { quoteIdent: s => d.quoteIdent(s), literal: v => d.literal(v), tableName: d.qualified(ref) });
    await fs.promises.writeFile(target.fsPath, fmt.id === 'csv' ? '﻿' + text : text, 'utf8');
    notifyExported(target, r.rows.length);
  });

  reg('hbd.importCsv', async (n?: DbNode) => {
    const { node, ref } = requireObj(n);
    await importCsv(await cm.getDriver(node.data.connId), ref);
    cm.fireTxChange(node.data.connId);
  });

  reg('hbd.dumpDatabase', async (n?: DbNode) => {
    const node = requireNode(n);
    if (!node.data.database) throw new Error('Seleccione una base de datos o esquema.');
    await dumpSql(await cm.getDriver(node.data.connId), node.data.database, node.data.schema);
  });

  log.appendLine(`hBD activado (${new Date().toLocaleString()})`);
}

export function deactivate(): void {
  /* las conexiones se cierran al desechar ConnectionManager */
}

function sampleValue(type: string): string {
  const t = type.toLowerCase();
  if (/int|serial|numeric|decimal|real|double|float|money|number/.test(t)) return '0';
  if (/bool|bit/.test(t)) return '0';
  if (/timestamp|datetime/.test(t)) return `'2024-01-01 00:00:00'`;
  if (/date/.test(t)) return `'2024-01-01'`;
  if (/time/.test(t)) return `'00:00:00'`;
  if (/json/.test(t)) return `'{}'`;
  return `''`;
}

async function importCsv(d: BaseDriver, ref: ObjectRef): Promise<void> {
  const pick = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'CSV / TSV': ['csv', 'tsv', 'txt'], 'Todos': ['*'] } });
  if (!pick?.[0]) return;
  const text = await fs.promises.readFile(pick[0].fsPath, 'utf8');
  const detected = detectDelimiter(text);
  const names: Record<string, string> = { ',': 'Coma (,)', ';': 'Punto y coma (;)', '\t': 'Tabulador', '|': 'Barra (|)' };
  const delimPick = await vscode.window.showQuickPick(
    [detected, ...Object.keys(names).filter(k => k !== detected)].map(k => ({ label: names[k], description: k === detected ? 'detectado' : undefined, k })),
    { placeHolder: 'Delimitador' });
  if (!delimPick) return;
  const rows = parseCsv(text, delimPick.k);
  if (rows.length < 2) throw new Error('El archivo no tiene filas de datos (se espera una fila de encabezados).');
  const header = rows[0].map(h => h.trim());
  const cols = await d.listColumns(ref);
  const byName = new Map(cols.map(c => [c.name.toLowerCase(), c.name]));
  const mapping = header.map(h => byName.get(h.toLowerCase()));
  const used = mapping.map((m, i) => (m ? i : -1)).filter(i => i >= 0);
  if (!used.length) throw new Error(`Ninguna columna del CSV coincide con las de ${ref.name}. Encabezados: ${header.join(', ')}`);
  const ignored = header.filter((_, i) => !mapping[i]);
  const emptyPick = await vscode.window.showQuickPick([
    { label: 'Valores vacíos como NULL', v: true },
    { label: 'Valores vacíos como cadena vacía', v: false }
  ], { placeHolder: 'Tratamiento de celdas vacías' });
  if (!emptyPick) return;
  const data = rows.slice(1);
  const ok = await vscode.window.showInformationMessage(
    `Importar ${data.length} fila(s) en ${d.qualified(ref)}?`,
    { modal: true, detail: `Columnas: ${used.map(i => mapping[i]).join(', ')}${ignored.length ? `\nIgnoradas: ${ignored.join(', ')}` : ''}\n\nSe ejecuta en una única transacción.` },
    'Importar');
  if (ok !== 'Importar') return;
  const colList = used.map(i => d.quoteIdent(mapping[i]!)).join(', ');
  const chunk = d.config.driver === 'mssql' ? 900 : 200;
  const stmts: string[] = [];
  for (let s = 0; s < data.length; s += chunk) {
    const values = data.slice(s, s + chunk).map(r =>
      '(' + used.map(i => {
        const v = r[i] ?? '';
        return v === '' && emptyPick.v ? 'NULL' : d.literal(v);
      }).join(', ') + ')');
    stmts.push(`INSERT INTO ${d.qualified(ref)} (${colList}) VALUES\n${values.join(',\n')}`);
  }
  const affected = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `hBD: importando en ${ref.name}…` },
    () => d.executeBatch(stmts, ref.database));
  vscode.window.showInformationMessage(`hBD: ${affected || data.length} fila(s) importadas en ${ref.name}.${d.autoCommit ? '' : ' (pendiente de commit)'}`);
}

async function dumpSql(d: BaseDriver, database: string, schema: string | undefined): Promise<void> {
  const mode = await vscode.window.showQuickPick([
    { label: 'Estructura y datos', s: true, dt: true },
    { label: 'Solo estructura', s: true, dt: false },
    { label: 'Solo datos', s: false, dt: true }
  ], { placeHolder: 'Contenido del dump' });
  if (!mode) return;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const name = `${schema ?? database}_${new Date().toISOString().slice(0, 10)}.sql`;
  const target = await vscode.window.showSaveDialog({ defaultUri: folder ? vscode.Uri.joinPath(folder, name) : vscode.Uri.file(name), filters: { SQL: ['sql'] } });
  if (!target) return;
  const isMy = d.config.driver === 'mysql' || d.config.driver === 'mariadb';
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'hBD: generando dump', cancellable: true }, async (progress, token) => {
    const out = fs.createWriteStream(target.fsPath, { encoding: 'utf8' });
    const write = (s: string) => new Promise<void>(res => { if (!out.write(s)) out.once('drain', () => res()); else res(); });
    await write(`-- Dump generado por hBD\n-- Conexión: ${d.config.name} (${DRIVER_LABELS[d.config.driver]})\n-- Base: ${database}${schema ? `, esquema: ${schema}` : ''}\n-- Fecha: ${new Date().toLocaleString()}\n\n`);
    if (isMy) await write('SET FOREIGN_KEY_CHECKS = 0;\n\n');
    if (d.config.driver === 'sqlite') await write('PRAGMA foreign_keys = OFF;\n\n');
    const tables = await d.listObjects(database, schema, 'table');
    const views = d.caps.kinds.includes('view') ? await d.listObjects(database, schema, 'view') : [];
    const total = tables.length * ((mode.s ? 1 : 0) + (mode.dt ? 1 : 0)) + (mode.s ? views.length : 0);
    const step = total ? 100 / total : 100;
    let rows = 0;
    if (mode.s) {
      for (const t of tables) {
        if (token.isCancellationRequested) break;
        progress.report({ message: `estructura ${t.name}`, increment: step });
        await write(`-- Tabla ${t.name}\n${(await d.getDDL(t)).trim()}\n\n`);
      }
    }
    if (mode.dt) {
      for (const t of tables) {
        if (token.isCancellationRequested) break;
        progress.report({ message: `datos ${t.name}`, increment: step });
        const r = await d.execute(d.selectAllSql(t), database);
        if (!r.rows.length) continue;
        rows += r.rows.length;
        await write(`-- Datos de ${t.name} (${r.rows.length} filas)\n`);
        await write(formatData('sql', r.columns.map(c => c.name), normalizeRows(r.rows), { quoteIdent: s => d.quoteIdent(s), literal: v => d.literal(v), tableName: d.qualified(t) }));
        await write('\n');
      }
    }
    if (mode.s) {
      for (const v of views) {
        if (token.isCancellationRequested) break;
        progress.report({ message: `vista ${v.name}`, increment: step });
        await write(`-- Vista ${v.name}\n${(await d.getDDL(v)).trim().replace(/;?$/, ';')}\n\n`);
      }
    }
    if (isMy) await write('SET FOREIGN_KEY_CHECKS = 1;\n');
    if (d.config.driver === 'sqlite') await write('PRAGMA foreign_keys = ON;\n');
    await new Promise<void>(res => out.end(() => res()));
    vscode.window.showInformationMessage(`hBD: dump generado (${tables.length} tablas, ${rows} filas) en ${target.fsPath}`, 'Abrir').then(c => {
      if (c) vscode.commands.executeCommand('vscode.open', target);
    });
  });
}
