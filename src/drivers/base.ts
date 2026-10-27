import { firstKeyword } from '../sql/splitter';
import {
  Capabilities, ColumnInfo, ConnectionConfig, ForeignKeyInfo, IndexInfo, ObjectKind, ObjectRef, QueryResult, SqlDialect
} from './types';

const READ_KEYWORDS = new Set(['select', 'with', 'show', 'explain', 'describe', 'desc', 'pragma', 'values', 'table', 'use']);
const TX_KEYWORDS = new Set(['begin', 'start', 'commit', 'rollback', 'end', 'savepoint', 'release']);

export type Row = Record<string, any>;

export interface TableRef {
  database: string;
  schema?: string;
  name: string;
}

export abstract class BaseDriver {
  abstract readonly caps: Capabilities;
  abstract readonly dialect: SqlDialect;
  autoCommit = true;
  protected openTx = new Set<string>();
  protected beginSql = 'BEGIN';
  protected commitSql = 'COMMIT';
  protected rollbackSql = 'ROLLBACK';

  constructor(readonly config: ConnectionConfig) {}

  abstract connect(password: string | undefined): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract isConnected(): boolean;
  /** Ejecuta una única sentencia en la base indicada. */
  protected abstract run(sql: string, database: string, maxRows?: number): Promise<QueryResult>;
  abstract defaultDatabase(): string;
  abstract listDatabases(): Promise<string[]>;
  abstract listSchemas(database: string): Promise<string[]>;
  abstract listObjects(database: string, schema: string | undefined, kind: ObjectKind): Promise<ObjectRef[]>;
  abstract listColumns(ref: TableRef): Promise<ColumnInfo[]>;
  abstract listIndexes(ref: TableRef): Promise<IndexInfo[]>;
  abstract listForeignKeys(ref: TableRef): Promise<ForeignKeyInfo[]>;
  abstract listTriggers(ref: TableRef): Promise<ObjectRef[]>;
  abstract getDDL(ref: ObjectRef): Promise<string>;
  abstract quoteIdent(name: string): string;
  abstract searchObjects(pattern: string): Promise<ObjectRef[]>;
  abstract sessionsSql(): string;
  abstract versionSql(): string;

  defaultSchema(): string | undefined {
    return undefined;
  }

  /** Cierra sesiones propias abiertas contra una base (antes de un DROP DATABASE). */
  async releaseDatabase(_database: string): Promise<void> { /* nada por defecto */ }

  get hasOpenTransaction(): boolean {
    return this.openTx.size > 0;
  }

  isReadOnlyStatement(sql: string): boolean {
    return READ_KEYWORDS.has(firstKeyword(sql));
  }

  /** Ejecuta una sentencia de usuario respetando modo de transacción y conexión de solo lectura. */
  async execute(sql: string, database?: string, maxRows?: number): Promise<QueryResult> {
    const db = database || this.defaultDatabase();
    const kw = firstKeyword(sql);
    if (this.config.readOnly && !READ_KEYWORDS.has(kw)) {
      throw new Error('La conexión es de solo lectura: solo se permiten consultas.');
    }
    if (!this.autoCommit && !this.openTx.has(db) && !TX_KEYWORDS.has(kw)) {
      await this.run(this.beginSql, db);
      this.openTx.add(db);
    }
    const start = Date.now();
    const res = await this.run(sql, db, maxRows);
    res.durationMs = Date.now() - start;
    if (kw === 'commit' || kw === 'rollback' || kw === 'end') this.openTx.delete(db);
    else if ((kw === 'begin' && !/^\s*begin\s+(dialog|conversation|distributed)/i.test(sql)) || kw === 'start') this.openTx.add(db);
    return res;
  }

  /** Ejecuta varias sentencias de forma atómica. Devuelve el total de filas afectadas. */
  async executeBatch(statements: string[], database?: string): Promise<number> {
    const db = database || this.defaultDatabase();
    if (this.config.readOnly) throw new Error('La conexión es de solo lectura.');
    let total = 0;
    if (!this.autoCommit) {
      for (const s of statements) total += (await this.execute(s, db)).affectedRows ?? 0;
      return total;
    }
    await this.run(this.beginSql, db);
    this.openTx.add(db);
    try {
      for (const s of statements) total += (await this.run(s, db)).affectedRows ?? 0;
      await this.run(this.commitSql, db);
    } catch (e) {
      try { await this.run(this.rollbackSql, db); } catch { /* ignorar */ }
      throw e;
    } finally {
      this.openTx.delete(db);
      await this.afterTransaction();
    }
    return total;
  }

  /** Gancho para motores que deben persistir tras una transacción (SQLite). */
  protected async afterTransaction(): Promise<void> { /* nada */ }

  async commit(): Promise<void> {
    for (const db of [...this.openTx]) await this.run(this.commitSql, db);
    this.openTx.clear();
    await this.afterTransaction();
  }

  async rollback(): Promise<void> {
    for (const db of [...this.openTx]) await this.run(this.rollbackSql, db);
    this.openTx.clear();
    await this.afterTransaction();
  }

  async setAutoCommit(value: boolean): Promise<void> {
    if (value && this.openTx.size) await this.commit();
    this.autoCommit = value;
  }

  async explain(sql: string, database?: string): Promise<QueryResult> {
    return this.execute('EXPLAIN ' + sql, database);
  }

  async version(): Promise<string> {
    const r = await this.run(this.versionSql(), this.defaultDatabase());
    return String(r.rows[0]?.[0] ?? '');
  }

  /** Consulta interna de metadatos; devuelve filas como objetos con claves en minúsculas. */
  protected async rows(sql: string, database?: string): Promise<Row[]> {
    const r = await this.run(sql, database ?? this.defaultDatabase());
    return r.rows.map(row => {
      const o: Row = {};
      r.columns.forEach((c, i) => { o[c.name.toLowerCase()] = row[i]; });
      return o;
    });
  }

  str(v: string): string {
    return `'${v.replace(/'/g, "''")}'`;
  }

  literal(v: unknown): string {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'bigint') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    return this.str(String(v));
  }

  qualified(ref: TableRef): string {
    return ref.schema ? `${this.quoteIdent(ref.schema)}.${this.quoteIdent(ref.name)}` : this.quoteIdent(ref.name);
  }

  selectPageSql(ref: TableRef, where: string, orderBy: string, limit: number, offset: number): string {
    return `SELECT * FROM ${this.qualified(ref)}${where ? ` WHERE ${where}` : ''}${orderBy ? ` ORDER BY ${orderBy}` : ''} LIMIT ${limit} OFFSET ${offset}`;
  }

  selectAllSql(ref: TableRef, where = '', orderBy = ''): string {
    return `SELECT * FROM ${this.qualified(ref)}${where ? ` WHERE ${where}` : ''}${orderBy ? ` ORDER BY ${orderBy}` : ''}`;
  }

  countSql(ref: TableRef, where = ''): string {
    return `SELECT COUNT(*) FROM ${this.qualified(ref)}${where ? ` WHERE ${where}` : ''}`;
  }

  truncateSql(ref: TableRef): string {
    return `TRUNCATE TABLE ${this.qualified(ref)}`;
  }

  insertDefaultSql(ref: TableRef): string {
    return `INSERT INTO ${this.qualified(ref)} DEFAULT VALUES`;
  }

  dropSql(ref: ObjectRef): string {
    const kw: Record<ObjectKind, string> = {
      table: 'TABLE', view: 'VIEW', matview: 'MATERIALIZED VIEW', function: 'FUNCTION',
      procedure: 'PROCEDURE', sequence: 'SEQUENCE', trigger: 'TRIGGER'
    };
    return `DROP ${kw[ref.kind]} ${this.qualified(ref)}`;
  }

  createDatabaseSql(name: string): string {
    return `CREATE DATABASE ${this.quoteIdent(name)}`;
  }

  dropDatabaseSql(name: string): string {
    return `DROP DATABASE ${this.quoteIdent(name)}`;
  }

  createSchemaSql(name: string): string {
    return `CREATE SCHEMA ${this.quoteIdent(name)}`;
  }

  dropSchemaSql(name: string): string {
    return `DROP SCHEMA ${this.quoteIdent(name)}`;
  }

  newTableTemplate(database: string, schema: string | undefined): string {
    const t = this.qualified({ database, schema, name: 'nueva_tabla' });
    return `CREATE TABLE ${t} (\n  id INTEGER NOT NULL PRIMARY KEY,\n  nombre VARCHAR(100) NOT NULL,\n  creado TIMESTAMP\n);\n`;
  }

  protected identityClause(_c: ColumnInfo): string {
    return '';
  }

  /** Construye un CREATE TABLE genérico a partir de los metadatos. */
  protected async genericTableDDL(ref: TableRef): Promise<string> {
    const [cols, idx, fks] = await Promise.all([this.listColumns(ref), this.listIndexes(ref), this.listForeignKeys(ref)]);
    const q = (s: string) => this.quoteIdent(s);
    const lines = cols.map(c =>
      `  ${q(c.name)} ${c.dataType}${this.identityClause(c)}${c.nullable ? '' : ' NOT NULL'}${c.defaultValue != null && c.defaultValue !== '' ? ' DEFAULT ' + c.defaultValue : ''}`);
    const pk = idx.find(i => i.primary);
    if (pk) lines.push(`  CONSTRAINT ${q(pk.name)} PRIMARY KEY (${pk.columns.map(q).join(', ')})`);
    else {
      const pkCols = cols.filter(c => c.isPrimaryKey);
      if (pkCols.length) lines.push(`  PRIMARY KEY (${pkCols.map(c => q(c.name)).join(', ')})`);
    }
    for (const fk of fks) {
      const target = this.qualified({ database: ref.database, schema: fk.refSchema, name: fk.refTable });
      lines.push(`  CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${target} (${fk.refColumns.map(q).join(', ')})` +
        (fk.onUpdate && !/no.action/i.test(fk.onUpdate) ? ` ON UPDATE ${fk.onUpdate.replace(/_/g, ' ')}` : '') +
        (fk.onDelete && !/no.action/i.test(fk.onDelete) ? ` ON DELETE ${fk.onDelete.replace(/_/g, ' ')}` : ''));
    }
    let out = `CREATE TABLE ${this.qualified(ref)} (\n${lines.join(',\n')}\n);\n`;
    for (const i of idx.filter(x => !x.primary)) {
      out += '\n' + (i.definition ? i.definition.replace(/;?\s*$/, ';') :
        `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${this.qualified(ref)} (${i.columns.map(q).join(', ')});`);
    }
    return out + (idx.some(x => !x.primary) ? '\n' : '');
  }

  /** Agrupa filas (name, col) en índices. */
  protected groupIndexes(rows: Row[]): IndexInfo[] {
    const map = new Map<string, IndexInfo>();
    for (const r of rows) {
      let ix = map.get(r.name);
      if (!ix) {
        ix = { name: r.name, columns: [], unique: !!Number(r.uq ?? 0) || r.uq === true, primary: !!Number(r.pk ?? 0) || r.pk === true };
        map.set(r.name, ix);
      }
      ix.columns.push(r.col);
    }
    return [...map.values()];
  }

  protected groupForeignKeys(rows: Row[]): ForeignKeyInfo[] {
    const map = new Map<string, ForeignKeyInfo>();
    for (const r of rows) {
      let fk = map.get(r.name);
      if (!fk) {
        fk = { name: r.name, columns: [], refSchema: r.rs ?? undefined, refTable: r.rt, refColumns: [], onUpdate: r.ur ?? undefined, onDelete: r.dr ?? undefined };
        map.set(r.name, fk);
      }
      fk.columns.push(r.col);
      fk.refColumns.push(r.rc);
    }
    return [...map.values()];
  }
}
