import * as vscode from 'vscode';

export interface HistoryEntry {
  id: string;
  sql: string;
  connId: string;
  connName: string;
  database?: string;
  time: number;
  duration?: number;
  rows?: number;
  error?: string;
}

const KEY = 'hbd.history';

export class HistoryItem extends vscode.TreeItem {
  constructor(readonly entry: HistoryEntry) {
    super(entry.sql.replace(/\s+/g, ' ').trim().slice(0, 100), vscode.TreeItemCollapsibleState.None);
    const d = new Date(entry.time);
    this.description = `${entry.connName}${entry.database ? '/' + entry.database : ''} · ${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
    const md = new vscode.MarkdownString();
    md.appendCodeblock(entry.sql.length > 4000 ? entry.sql.slice(0, 4000) + '\n…' : entry.sql, 'sql');
    md.appendMarkdown(`\n${entry.connName}${entry.database ? ' / ' + entry.database : ''} — ${d.toLocaleString()}` +
      (entry.duration !== undefined ? ` — ${entry.duration} ms` : '') + (entry.rows !== undefined ? ` — ${entry.rows} filas` : ''));
    if (entry.error) md.appendMarkdown(`\n\n**Error:** ${entry.error}`);
    this.tooltip = md;
    this.iconPath = new vscode.ThemeIcon(entry.error ? 'error' : 'history', entry.error ? new vscode.ThemeColor('errorForeground') : undefined);
    this.contextValue = 'history';
    this.command = { command: 'hbd.history.open', title: 'Abrir', arguments: [this] };
  }
}

export class QueryHistory implements vscode.TreeDataProvider<HistoryItem> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private entries: HistoryEntry[];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.entries = ctx.globalState.get<HistoryEntry[]>(KEY, []);
  }

  getTreeItem(e: HistoryItem): vscode.TreeItem {
    return e;
  }

  getChildren(): HistoryItem[] {
    return this.entries.map(e => new HistoryItem(e));
  }

  async add(e: Omit<HistoryEntry, 'id' | 'time'>): Promise<void> {
    const max = vscode.workspace.getConfiguration('hbd').get<number>('history.maxEntries', 500);
    const entry: HistoryEntry = { ...e, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time: Date.now() };
    // evitar duplicados consecutivos
    if (this.entries[0] && this.entries[0].sql === entry.sql && this.entries[0].connId === entry.connId) this.entries.shift();
    this.entries.unshift(entry);
    if (this.entries.length > max) this.entries.length = max;
    await this.ctx.globalState.update(KEY, this.entries);
    this._onDidChange.fire();
  }

  async remove(id: string): Promise<void> {
    this.entries = this.entries.filter(e => e.id !== id);
    await this.ctx.globalState.update(KEY, this.entries);
    this._onDidChange.fire();
  }

  async clear(): Promise<void> {
    this.entries = [];
    await this.ctx.globalState.update(KEY, this.entries);
    this._onDidChange.fire();
  }
}
