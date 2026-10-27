import * as fs from 'fs';
import * as path from 'path';
import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';
import { BaseDriver, TableRef } from './base';
import { firstKeyword } from '../sql/splitter';
import { Capabilities, ColumnInfo, ForeignKeyInfo, IndexInfo, ObjectKind, ObjectRef, QueryResult, SqlDialect } from './types';

let sqlJs: Promise<SqlJsStatic> | undefined;
function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJs) {
    const dist = path.dirname(require.resolve('sql.js'));
    sqlJs = initSqlJs({ locateFile: (f: string) => path.join(dist, f) });
  }
  return sqlJs;
}

/**
 * SQLite mediante sql.js (WebAssembly, sin dependencias nativas).
 * La base se carga en memoria y se persiste al archivo tras cada cambio confirmado.
 */
export class SqliteDriver extends BaseDriver {
  readonly dialect: SqlDialect = 'sqlite';
  readonly caps: Capabilities = { schemas: false, kinds: ['table', 'view'], createDatabase: false, createSchema: false };
  private db: Database | undefined;
  private dirty = false;

  async connect(): Promise<void> {
    const SQL = await loadSqlJs();
    const file = this.config.filePath;
    if (!file) throw new Error('Debe indicar el archivo de la base SQLite.');
    if (fs.existsSync(file)) {
      this.db = new SQL.Database(fs.readFileSync(file));
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.db = new SQL.Database();
      this.persist();
    }
    this.db.run('PRAGMA foreign_keys = ON');
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      if (this.dirty && !this.openTx.size) this.persist();
      this.db.close();
    }
    this.db = undefined;
    this.openTx.clear();
  }

  isConnected(): boolean {
    return !!this.db;
  }

  defaultDatabase(): string {
    return 'main';
  }

  private persist(): void {
    if (!this.db || !this.config.filePath || this.config.readOnly) return;
    fs.writeFileSync(this.config.filePath, Buffer.from(this.db.export()));
    this.db.run('PRAGMA foreign_keys = ON');
    this.dirty = false;
  }

  protected async afterTransaction(): Promise<void> {
    if (this.dirty && !this.openTx.size) this.persist();
  }

  protected async run(sql: string, _database: string, maxRows?: number): Promise<QueryResult> {
    if (!this.db) throw new Error('No hay conexión activa.');
    const stmt = this.db.prepare(sql);
    const rows: unknown[][] = [];
    let truncated = false;
    let columns: string[] = [];
    try {
      columns = stmt.getColumnNames();
      while (stmt.step()) {
        if (maxRows && rows.length >= maxRows) { truncated = true; break; }
        rows.push(stmt.get() as unknown[]);
      }
    } finally {
      stmt.free();
    }
    const kw = firstKeyword(sql);
    if (!columns.length) {
      const affected = this.db.getRowsModified();
      if (!['select', 'pragma', 'explain'].includes(kw)) this.dirty = true;
      if (kw === 'begin') this.openTx.add('main');
      if (kw === 'commit' || kw === 'end' || kw === 'rollback') this.openTx.delete('main');
      if (this.dirty && this.autoCommit && !this.openTx.size) this.persist();
      return { columns: [], rows: [], affectedRows: affected, durationMs: 0 };
    }
    return { columns: columns.map(name => ({ name })), rows, durationMs: 0, truncated };
  }

  quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  qualified(ref: TableRef): string {
    return ref.database && ref.database !== 'main' ? `${this.quoteIdent(ref.database)}.${this.quoteIdent(ref.name)}` : this.quoteIdent(ref.name);
  }

  private master(db: string): string {
    return db && db !== 'main' ? `${this.quoteIdent(db)}.sqlite_master` : 'sqlite_master';
  }

  private pragma(db: string, name: string, arg: string): string {
    return `PRAGMA ${db && db !== 'main' ? this.quoteIdent(db) + '.' : ''}${name}(${this.quoteIdent(arg)})`;
  }

  truncateSql(ref: TableRef): string {
    return `DELETE FROM ${this.qualified(ref)}`;
  }

  versionSql(): string {
    return 'SELECT sqlite_version()';
  }

  sessionsSql(): string {
    return 'PRAGMA database_list';
  }

  async explain(sql: string, database?: string): Promise<QueryResult> {
    return this.execute('EXPLAIN QUERY PLAN ' + sql, database);
  }

  async listDatabases(): Promise<string[]> {
    const r = await this.rows('PRAGMA database_list');
    return r.map(x => x.name).filter(n => n !== 'temp');
  }

  async listSchemas(): Promise<string[]> {
    return [];
  }

  async listObjects(database: string, _schema: string | undefined, kind: ObjectKind): Promise<ObjectRef[]> {
    if (kind !== 'table' && kind !== 'view') return [];
    const sys = this.config.showSystemObjects ? '' : ` AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`;
    const r = await this.rows(`SELECT name FROM ${this.master(database)} WHERE type = '${kind}'${sys} ORDER BY name`);
    return r.map(x => ({ database, name: x.name, kind }));
  }

  async listColumns(ref: TableRef): Promise<ColumnInfo[]> {
    const r = await this.rows(this.pragma(ref.database, 'table_info', ref.name));
    const pkCount = r.filter(x => Number(x.pk) > 0).length;
    return r.map(x => ({
      name: x.name,
      dataType: x.type || '',
      nullable: !Number(x.notnull) && !Number(x.pk),
      defaultValue: x.dflt_value,
      isPrimaryKey: Number(x.pk) > 0,
      isAutoIncrement: Number(x.pk) > 0 && pkCount === 1 && /^integer$/i.test(x.type || ''),
      ordinal: Number(x.cid) + 1
    }));
  }

  async listIndexes(ref: TableRef): Promise<IndexInfo[]> {
    const list = await this.rows(this.pragma(ref.database, 'index_list', ref.name));
    const out: IndexInfo[] = [];
    for (const ix of list) {
      const info = await this.rows(this.pragma(ref.database, 'index_info', ix.name));
      const def = await this.rows(`SELECT sql FROM ${this.master(ref.database)} WHERE type = 'index' AND name = ${this.str(ix.name)}`);
      out.push({
        name: ix.name,
        unique: !!Number(ix.unique),
        primary: ix.origin === 'pk',
        columns: info.map(c => c.name),
        definition: def[0]?.sql ?? undefined
      });
    }
    // PK implícita (rowid) no aparece en index_list
    if (!out.some(i => i.primary)) {
      const pk = (await this.listColumns(ref)).filter(c => c.isPrimaryKey).map(c => c.name);
      if (pk.length) out.unshift({ name: 'PRIMARY', unique: true, primary: true, columns: pk });
    }
    return out;
  }

  async listForeignKeys(ref: TableRef): Promise<ForeignKeyInfo[]> {
    const r = await this.rows(this.pragma(ref.database, 'foreign_key_list', ref.name));
    const map = new Map<number, ForeignKeyInfo>();
    for (const x of r) {
      let fk = map.get(Number(x.id));
      if (!fk) {
        fk = { name: `fk_${ref.name}_${x.id}`, columns: [], refTable: x.table, refColumns: [], onUpdate: x.on_update, onDelete: x.on_delete };
        map.set(Number(x.id), fk);
      }
      fk.columns.push(x.from);
      fk.refColumns.push(x.to ?? x.from);
    }
    return [...map.values()];
  }

  async listTriggers(ref: TableRef): Promise<ObjectRef[]> {
    const r = await this.rows(`SELECT name FROM ${this.master(ref.database)} WHERE type = 'trigger' AND tbl_name = ${this.str(ref.name)} ORDER BY name`);
    return r.map(x => ({ database: ref.database, name: x.name, kind: 'trigger' as ObjectKind, parent: ref.name }));
  }

  async getDDL(ref: ObjectRef): Promise<string> {
    const m = this.master(ref.database);
    const main = await this.rows(`SELECT sql FROM ${m} WHERE name = ${this.str(ref.name)}`);
    let out = String(main[0]?.sql ?? '') + ';\n';
    if (ref.kind === 'table') {
      const extra = await this.rows(`SELECT sql FROM ${m} WHERE tbl_name = ${this.str(ref.name)} AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name`);
      for (const e of extra) out += `\n${e.sql};\n`;
    }
    return out;
  }

  async searchObjects(pattern: string): Promise<ObjectRef[]> {
    const r = await this.rows(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view','trigger') AND name LIKE ${this.str(`%${pattern}%`)} ORDER BY name`);
    return r.map(x => ({ database: 'main', name: x.name, kind: x.type as ObjectKind }));
  }

  newTableTemplate(database: string): string {
    const t = this.qualified({ database, name: 'nueva_tabla' });
    return `CREATE TABLE ${t} (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  nombre TEXT NOT NULL,\n  creado TEXT DEFAULT CURRENT_TIMESTAMP\n);\n`;
  }
}
