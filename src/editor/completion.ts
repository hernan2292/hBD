import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';
import { BaseDriver } from '../drivers';
import { ColumnInfo, ObjectRef } from '../drivers/types';
import { splitSql, statementAt } from '../sql/splitter';
import { SqlEditorManager } from './sqlEditor';

const KEYWORDS = `SELECT FROM WHERE AND OR NOT IN IS NULL LIKE ILIKE BETWEEN EXISTS AS DISTINCT ORDER BY GROUP HAVING LIMIT OFFSET FETCH
JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING UNION ALL INTERSECT EXCEPT INSERT INTO VALUES UPDATE SET DELETE RETURNING
CREATE ALTER DROP TABLE VIEW INDEX UNIQUE PRIMARY KEY FOREIGN REFERENCES CONSTRAINT DEFAULT CHECK SEQUENCE SCHEMA DATABASE
FUNCTION PROCEDURE TRIGGER BEGIN END COMMIT ROLLBACK TRANSACTION CASE WHEN THEN ELSE CAST COALESCE NULLIF COUNT SUM AVG MIN MAX
WITH RECURSIVE OVER PARTITION ROW_NUMBER RANK DENSE_RANK LAG LEAD ASC DESC NULLS FIRST LAST TRUNCATE EXPLAIN ANALYZE GRANT REVOKE
CASCADE RESTRICT IF REPLACE TEMPORARY TEMP ADD COLUMN RENAME TO TRUE FALSE CURRENT_DATE CURRENT_TIMESTAMP NOW LOWER UPPER TRIM
SUBSTRING LENGTH CONCAT ROUND FLOOR CEIL ABS EXTRACT INTERVAL DATE TIMESTAMP INTEGER BIGINT VARCHAR TEXT BOOLEAN NUMERIC DECIMAL`.split(/\s+/);

const NOT_ALIAS = new Set(['where', 'on', 'join', 'inner', 'left', 'right', 'full', 'cross', 'outer', 'group', 'order', 'limit', 'set',
  'values', 'union', 'having', 'natural', 'using', 'returning', 'select', 'offset', 'fetch', 'window', 'lateral', 'as']);

/** Cache de metadatos para autocompletado. */
export class MetadataCache {
  private tables = new Map<string, Promise<ObjectRef[]>>();
  private schemas = new Map<string, Promise<string[]>>();
  private columns = new Map<string, Promise<ColumnInfo[]>>();

  clear(connId?: string): void {
    for (const m of [this.tables, this.schemas, this.columns] as Map<string, unknown>[]) {
      for (const k of [...m.keys()]) if (!connId || k.startsWith(connId + '|')) m.delete(k);
    }
  }

  getSchemas(connId: string, d: BaseDriver, db: string): Promise<string[]> {
    const k = `${connId}|${db}`;
    let p = this.schemas.get(k);
    if (!p) { p = d.caps.schemas ? d.listSchemas(db).catch(() => []) : Promise.resolve([]); this.schemas.set(k, p); }
    return p;
  }

  getTables(connId: string, d: BaseDriver, db: string, schema: string | undefined): Promise<ObjectRef[]> {
    const k = `${connId}|${db}|${schema ?? ''}`;
    let p = this.tables.get(k);
    if (!p) {
      p = Promise.all([d.listObjects(db, schema, 'table'), d.listObjects(db, schema, 'view')])
        .then(([a, b]) => [...a, ...b]).catch(() => []);
      this.tables.set(k, p);
    }
    return p;
  }

  getColumns(connId: string, d: BaseDriver, ref: { database: string; schema?: string; name: string }): Promise<ColumnInfo[]> {
    const k = `${connId}|${ref.database}|${ref.schema ?? ''}|${ref.name}`;
    let p = this.columns.get(k);
    if (!p) { p = d.listColumns(ref).catch(() => []); this.columns.set(k, p); }
    return p;
  }
}

const unq = (s: string) => s.replace(/^["`\[]|["`\]]$/g, '');

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly cm: ConnectionManager, private readonly sqlm: SqlEditorManager, private readonly cache: MetadataCache) {}

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[]> {
    const a = this.sqlm.getAssoc(doc);
    const driver = a ? this.cm.connectedDriver(a.connId) : undefined;
    const linePrefix = doc.lineAt(pos.line).text.slice(0, pos.character);
    const items: vscode.CompletionItem[] = [];
    if (!driver || !a) return this.keywordItems();

    const db = a.database || driver.defaultDatabase();
    const defSchema = driver.defaultSchema();
    const stmts = splitSql(doc.getText(), this.sqlm.dialectFor(doc) ?? 'postgresql', { blankLineDelimiter: true });
    const stmt = statementAt(stmts, doc.offsetAt(pos))?.text ?? '';
    const refs = parseTableRefs(stmt);

    const dot = /((?:[\w$]+|"[^"]+"|`[^`]+`|\[[^\]]+\])\.)?([\w$]+|"[^"]+"|`[^`]+`|\[[^\]]+\])\.([\w$]*)$/.exec(linePrefix);
    if (dot) {
      const qualifier = unq(dot[2]);
      const outer = dot[1] ? unq(dot[1].slice(0, -1)) : undefined;
      // alias o tabla del FROM
      const ref = refs.find(r => r.alias?.toLowerCase() === qualifier.toLowerCase() || r.name.toLowerCase() === qualifier.toLowerCase());
      if (ref) {
        const cols = await this.cache.getColumns(a.connId, driver, { database: driver.caps.schemas ? db : (ref.schema ?? db), schema: driver.caps.schemas ? (ref.schema ?? defSchema) : undefined, name: ref.name });
        if (cols.length) return cols.map(c => this.columnItem(c, ref.name));
      }
      if (outer && driver.caps.schemas) {
        // schema.tabla.
        const cols = await this.cache.getColumns(a.connId, driver, { database: db, schema: outer, name: qualifier });
        return cols.map(c => this.columnItem(c, qualifier));
      }
      // esquema. (o base. en MySQL)
      const tables = driver.caps.schemas
        ? await this.cache.getTables(a.connId, driver, db, qualifier)
        : await this.cache.getTables(a.connId, driver, qualifier, undefined);
      if (tables.length) return tables.map(t => this.tableItem(t, driver));
      // tabla sin alias
      const cols = await this.cache.getColumns(a.connId, driver, { database: db, schema: driver.caps.schemas ? defSchema : undefined, name: qualifier });
      return cols.map(c => this.columnItem(c, qualifier));
    }

    // columnas de las tablas referenciadas
    for (const r of refs.slice(0, 8)) {
      const cols = await this.cache.getColumns(a.connId, driver, { database: driver.caps.schemas ? db : (r.schema ?? db), schema: driver.caps.schemas ? (r.schema ?? defSchema) : undefined, name: r.name });
      for (const c of cols) {
        const it = this.columnItem(c, r.alias ?? r.name);
        it.sortText = '0' + c.name;
        items.push(it);
      }
    }
    // tablas del esquema por defecto
    const tables = await this.cache.getTables(a.connId, driver, db, driver.caps.schemas ? defSchema : undefined);
    for (const t of tables) items.push(this.tableItem(t, driver));
    // esquemas / bases
    if (driver.caps.schemas) {
      for (const s of await this.cache.getSchemas(a.connId, driver, db)) {
        const it = new vscode.CompletionItem(s, vscode.CompletionItemKind.Module);
        it.detail = 'esquema';
        it.sortText = '2' + s;
        items.push(it);
      }
    }
    return items.concat(this.keywordItems());
  }

  private keywordItems(): vscode.CompletionItem[] {
    return KEYWORDS.map(k => {
      const it = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword);
      it.sortText = '9' + k;
      return it;
    });
  }

  private columnItem(c: ColumnInfo, table: string): vscode.CompletionItem {
    const it = new vscode.CompletionItem({ label: c.name, description: c.dataType, detail: c.isPrimaryKey ? ' 🔑' : undefined }, vscode.CompletionItemKind.Field);
    it.detail = `${table}.${c.name} : ${c.dataType}${c.nullable ? '' : ' NOT NULL'}`;
    if (c.comment) it.documentation = c.comment;
    it.sortText = '0' + c.name;
    return it;
  }

  private tableItem(t: ObjectRef, driver: BaseDriver): vscode.CompletionItem {
    const it = new vscode.CompletionItem({ label: t.name, description: t.kind === 'view' ? 'vista' : 'tabla' },
      t.kind === 'view' ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class);
    const quoted = driver.quoteIdent(t.name);
    if (quoted !== t.name) it.insertText = quoted;
    it.detail = `${t.schema ? t.schema + '.' : ''}${t.name}`;
    if (t.comment) it.documentation = t.comment;
    it.sortText = '1' + t.name;
    return it;
  }
}

export interface TableRefInSql {
  schema?: string;
  name: string;
  alias?: string;
}

export function parseTableRefs(sql: string): TableRefInSql[] {
  const out: TableRefInSql[] = [];
  const ident = `(?:"[^"]+"|\`[^\`]+\`|\\[[^\\]]+\\]|[\\w$]+)`;
  const re = new RegExp(`\\b(?:from|join|update|into)\\s+(${ident}(?:\\.${ident}){0,2})(?:\\s+(?:as\\s+)?(${ident}))?`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const parts = m[1].split('.').map(unq);
    const name = parts[parts.length - 1];
    const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
    let alias = m[2] ? unq(m[2]) : undefined;
    if (alias && NOT_ALIAS.has(alias.toLowerCase())) alias = undefined;
    out.push({ schema, name, alias });
    // FROM a x, b y
    const rest = sql.slice(re.lastIndex);
    const comma = new RegExp(`^\\s*,\\s*(${ident}(?:\\.${ident})?)(?:\\s+(?:as\\s+)?(${ident}))?`, 'i').exec(rest);
    if (comma) {
      const p2 = comma[1].split('.').map(unq);
      let al2 = comma[2] ? unq(comma[2]) : undefined;
      if (al2 && NOT_ALIAS.has(al2.toLowerCase())) al2 = undefined;
      out.push({ schema: p2.length > 1 ? p2[0] : undefined, name: p2[p2.length - 1], alias: al2 });
    }
  }
  return out;
}
