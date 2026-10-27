import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';
import { BaseDriver } from '../drivers';
import { ConnectionConfig, DRIVER_LABELS, KIND_LABELS, ObjectKind, ObjectRef } from '../drivers/types';

export type NodeType = 'group' | 'connection' | 'database' | 'schema' | 'folder' | 'object' | 'sub' | 'column' | 'index' | 'foreignKey' | 'info';
export type SubKind = 'columns' | 'indexes' | 'fks' | 'triggers';

export interface NodeData {
  type: NodeType;
  connId: string;
  group?: string;
  database?: string;
  schema?: string;
  kind?: ObjectKind;
  obj?: ObjectRef;
  sub?: SubKind;
  name?: string;
}

const KIND_ICONS: Record<ObjectKind, string> = {
  table: 'table', view: 'eye', matview: 'eye-watch', function: 'symbol-function', procedure: 'symbol-method',
  sequence: 'symbol-number', trigger: 'zap'
};

const SUB_LABELS: Record<SubKind, string> = { columns: 'Columnas', indexes: 'Índices', fks: 'Claves foráneas', triggers: 'Triggers' };

export class DbNode extends vscode.TreeItem {
  constructor(readonly data: NodeData, label: string, state: vscode.TreeItemCollapsibleState) {
    super(label, state);
    this.id = [data.type, data.connId, data.group, data.database, data.schema, data.kind, data.obj?.name, data.obj?.signature, data.sub, data.name]
      .map(x => x ?? '').join('/');
  }

  /** Referencia de tabla/objeto o base/esquema que representa el nodo. */
  get ref(): ObjectRef | undefined {
    return this.data.obj;
  }
}

export class ConnectionTree implements vscode.TreeDataProvider<DbNode>, vscode.TreeDragAndDropController<DbNode> {
  private readonly _onDidChange = new vscode.EventEmitter<DbNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  readonly dragMimeTypes = ['text/plain'];
  readonly dropMimeTypes: string[] = [];
  private filters = new Map<string, string>();

  constructor(private readonly cm: ConnectionManager) {
    cm.onDidChange(() => this._onDidChange.fire());
  }

  refresh(node?: DbNode): void {
    this._onDidChange.fire(node);
  }

  setFilter(connId: string, filter: string | undefined): void {
    if (filter) this.filters.set(connId, filter.toLowerCase()); else this.filters.delete(connId);
    this._onDidChange.fire();
  }

  getFilter(connId: string): string | undefined {
    return this.filters.get(connId);
  }

  getTreeItem(node: DbNode): vscode.TreeItem {
    return node;
  }

  handleDrag(source: readonly DbNode[], dataTransfer: vscode.DataTransfer): void {
    const names = source.map(n => {
      const d = this.cm.connectedDriver(n.data.connId);
      if (n.data.obj && d) return d.qualified(n.data.obj);
      return n.data.name ?? (typeof n.label === 'string' ? n.label : '');
    }).filter(Boolean);
    dataTransfer.set('text/plain', new vscode.DataTransferItem(names.join(', ')));
  }

  async getChildren(node?: DbNode): Promise<DbNode[]> {
    try {
      if (!node) return this.roots();
      const d = node.data;
      switch (d.type) {
        case 'group': return this.cm.list().filter(c => (c.group || '') === d.group).map(c => this.connectionNode(c));
        case 'connection': return await this.connectionChildren(d.connId);
        case 'database': return await this.databaseChildren(d.connId, d.database!);
        case 'schema': return this.folderNodes(await this.cm.getDriver(d.connId), d.connId, d.database!, d.schema);
        case 'folder': return await this.objectNodes(d);
        case 'object': return this.subFolders(d);
        case 'sub': return await this.subChildren(d);
        default: return [];
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (!/cancelada/i.test(msg)) vscode.window.showErrorMessage(`hBD: ${msg}`);
      const n = new DbNode({ type: 'info', connId: node?.data.connId ?? '', name: 'error' }, msg, vscode.TreeItemCollapsibleState.None);
      n.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      return [n];
    }
  }

  private roots(): DbNode[] {
    const list = this.cm.list();
    const groups = [...new Set(list.map(c => c.group).filter((g): g is string => !!g))].sort();
    const out: DbNode[] = groups.map(g => {
      const n = new DbNode({ type: 'group', connId: '', group: g }, g, vscode.TreeItemCollapsibleState.Expanded);
      n.iconPath = new vscode.ThemeIcon('folder-library');
      n.contextValue = 'group';
      return n;
    });
    return out.concat(list.filter(c => !c.group).map(c => this.connectionNode(c)));
  }

  private connectionNode(c: ConnectionConfig): DbNode {
    const connected = this.cm.isConnected(c.id);
    const n = new DbNode({ type: 'connection', connId: c.id }, c.name, vscode.TreeItemCollapsibleState.Collapsed);
    const color = c.color ? new vscode.ThemeColor(c.color) : connected ? new vscode.ThemeColor('charts.green') : undefined;
    n.iconPath = new vscode.ThemeIcon(connected ? 'database' : 'server', color);
    const where = c.driver === 'sqlite' ? c.filePath : `${c.host ?? 'localhost'}${c.port ? ':' + c.port : ''}`;
    n.description = `${DRIVER_LABELS[c.driver]}${c.readOnly ? ' · solo lectura' : ''}${this.filters.has(c.id) ? ` · filtro: ${this.filters.get(c.id)}` : ''}`;
    n.tooltip = new vscode.MarkdownString(`**${c.name}**\n\n${DRIVER_LABELS[c.driver]} — ${where ?? ''}\n\n${c.user ? 'Usuario: ' + c.user + '\n\n' : ''}${c.database ? 'Base: ' + c.database + '\n\n' : ''}${c.ssh?.enabled ? 'Túnel SSH: ' + c.ssh.host + '\n\n' : ''}${connected ? '🟢 Conectado' : '⚪ Desconectado'}`);
    n.contextValue = connected ? 'connection:connected' : 'connection:disconnected';
    return n;
  }

  private async connectionChildren(connId: string): Promise<DbNode[]> {
    const driver = await this.cm.getDriver(connId);
    const cfg = driver.config;
    let dbs = await driver.listDatabases();
    if (cfg.driver === 'sqlite' && dbs.length <= 1) {
      return this.folderNodes(driver, connId, dbs[0] ?? 'main', undefined);
    }
    const showAll = vscode.workspace.getConfiguration('hbd').get<boolean>('showAllDatabases', true);
    if (!showAll && cfg.database) dbs = dbs.filter(d => d === cfg.database);
    return dbs.map(db => {
      const n = new DbNode({ type: 'database', connId, database: db, name: db }, db, vscode.TreeItemCollapsibleState.Collapsed);
      n.iconPath = new vscode.ThemeIcon('database', db === driver.defaultDatabase() ? new vscode.ThemeColor('charts.blue') : undefined);
      n.contextValue = 'database';
      return n;
    });
  }

  private async databaseChildren(connId: string, database: string): Promise<DbNode[]> {
    const driver = await this.cm.getDriver(connId);
    if (!driver.caps.schemas) return this.folderNodes(driver, connId, database, undefined);
    const schemas = await driver.listSchemas(database);
    return schemas.map(s => {
      const n = new DbNode({ type: 'schema', connId, database, schema: s, name: s }, s, vscode.TreeItemCollapsibleState.Collapsed);
      n.iconPath = new vscode.ThemeIcon('symbol-namespace');
      n.contextValue = 'schema';
      return n;
    });
  }

  private folderNodes(driver: BaseDriver, connId: string, database: string, schema: string | undefined): DbNode[] {
    return driver.caps.kinds.map(kind => {
      const n = new DbNode({ type: 'folder', connId, database, schema, kind }, KIND_LABELS[kind], vscode.TreeItemCollapsibleState.Collapsed);
      n.iconPath = new vscode.ThemeIcon('folder');
      n.contextValue = `folder:${kind}`;
      return n;
    });
  }

  private async objectNodes(d: NodeData): Promise<DbNode[]> {
    const driver = await this.cm.getDriver(d.connId);
    let objs = await driver.listObjects(d.database!, d.schema, d.kind!);
    const f = this.filters.get(d.connId);
    if (f) objs = objs.filter(o => o.name.toLowerCase().includes(f));
    return objs.map(o => this.objectNode(d.connId, o));
  }

  objectNode(connId: string, o: ObjectRef): DbNode {
    const expandable = o.kind === 'table' || o.kind === 'view' || o.kind === 'matview';
    const label = o.signature !== undefined ? `${o.name}(${o.signature})` : o.name;
    const n = new DbNode({ type: 'object', connId, database: o.database, schema: o.schema, kind: o.kind, obj: o, name: o.name }, label,
      expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    n.iconPath = new vscode.ThemeIcon(KIND_ICONS[o.kind]);
    n.contextValue = `object:${o.kind}`;
    n.tooltip = [o.schema ? `${o.schema}.${label}` : label, o.comment].filter(Boolean).join('\n\n');
    if (o.comment) n.description = o.comment;
    if (!expandable) n.command = { command: 'hbd.showDDL', title: 'Ver DDL', arguments: [n] };
    return n;
  }

  private subFolders(d: NodeData): DbNode[] {
    const subs: SubKind[] = d.kind === 'table' ? ['columns', 'indexes', 'fks', 'triggers'] : ['columns'];
    return subs.map(sub => {
      const n = new DbNode({ ...d, type: 'sub', sub }, SUB_LABELS[sub], vscode.TreeItemCollapsibleState.Collapsed);
      n.iconPath = new vscode.ThemeIcon('folder');
      n.contextValue = `sub:${sub}`;
      return n;
    });
  }

  private async subChildren(d: NodeData): Promise<DbNode[]> {
    const driver = await this.cm.getDriver(d.connId);
    const ref = d.obj!;
    const none = vscode.TreeItemCollapsibleState.None;
    switch (d.sub) {
      case 'columns': {
        const cols = await driver.listColumns(ref);
        return cols.map(c => {
          const n = new DbNode({ ...d, type: 'column', name: c.name }, c.name, none);
          n.description = `${c.dataType}${c.nullable ? '' : ' NOT NULL'}${c.isAutoIncrement ? ' · auto' : ''}`;
          n.iconPath = new vscode.ThemeIcon(c.isPrimaryKey ? 'key' : 'symbol-field', c.isPrimaryKey ? new vscode.ThemeColor('charts.yellow') : undefined);
          n.tooltip = new vscode.MarkdownString(`**${c.name}** \`${c.dataType}\`\n\n${c.nullable ? 'NULL' : 'NOT NULL'}${c.defaultValue != null ? `\n\nDefault: \`${c.defaultValue}\`` : ''}${c.comment ? `\n\n${c.comment}` : ''}`);
          n.contextValue = 'column';
          return n;
        });
      }
      case 'indexes': {
        const idx = await driver.listIndexes(ref);
        return idx.map(i => {
          const n = new DbNode({ ...d, type: 'index', name: i.name }, i.name, none);
          n.description = `(${i.columns.join(', ')})${i.primary ? ' · PK' : i.unique ? ' · UNIQUE' : ''}`;
          n.iconPath = new vscode.ThemeIcon(i.primary ? 'key' : 'list-ordered');
          n.tooltip = i.definition ?? n.description;
          n.contextValue = 'index';
          return n;
        });
      }
      case 'fks': {
        const fks = await driver.listForeignKeys(ref);
        return fks.map(f => {
          const n = new DbNode({ ...d, type: 'foreignKey', name: f.name }, f.name, none);
          n.description = `(${f.columns.join(', ')}) → ${f.refSchema ? f.refSchema + '.' : ''}${f.refTable}(${f.refColumns.join(', ')})`;
          n.iconPath = new vscode.ThemeIcon('references');
          n.tooltip = `${n.description}\nON UPDATE ${f.onUpdate ?? '-'}\nON DELETE ${f.onDelete ?? '-'}`;
          n.contextValue = 'foreignKey';
          return n;
        });
      }
      case 'triggers': {
        const trg = await driver.listTriggers(ref);
        return trg.map(t => this.objectNode(d.connId, t));
      }
    }
    return [];
  }
}
