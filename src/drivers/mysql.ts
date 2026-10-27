import * as mysql from 'mysql2/promise';
import { BaseDriver, TableRef } from './base';
import { Capabilities, ColumnInfo, ConnectionConfig, ForeignKeyInfo, IndexInfo, ObjectKind, ObjectRef, QueryResult, SqlDialect } from './types';

const MYSQL_TYPES: Record<number, string> = {
  0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 6: 'null', 7: 'timestamp', 8: 'bigint', 9: 'mediumint',
  10: 'date', 11: 'time', 12: 'datetime', 13: 'year', 15: 'varchar', 16: 'bit', 245: 'json', 246: 'decimal', 247: 'enum', 248: 'set',
  249: 'tinyblob', 250: 'mediumblob', 251: 'longblob', 252: 'blob', 253: 'varchar', 254: 'char', 255: 'geometry'
};

const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

export class MySqlDriver extends BaseDriver {
  readonly dialect: SqlDialect;
  readonly caps: Capabilities = {
    schemas: false,
    kinds: ['table', 'view', 'function', 'procedure'],
    createDatabase: true,
    createSchema: false
  };
  private conn: mysql.Connection | undefined;
  private currentDb = '';

  constructor(config: ConnectionConfig) {
    super(config);
    this.dialect = config.driver === 'mariadb' ? 'mariadb' : 'mysql';
    this.beginSql = 'START TRANSACTION';
  }

  async connect(password: string | undefined): Promise<void> {
    this.conn = await mysql.createConnection({
      host: this.config.host || 'localhost',
      port: this.config.port || 3306,
      user: this.config.user,
      password,
      database: this.config.database || undefined,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
      charset: 'utf8mb4'
    });
    this.conn.on('error', () => { this.conn = undefined; this.openTx.clear(); });
    this.currentDb = this.config.database || '';
    if (this.config.readOnly) await this.conn.query('SET SESSION TRANSACTION READ ONLY');
  }

  async disconnect(): Promise<void> {
    const c = this.conn;
    this.conn = undefined;
    this.openTx.clear();
    if (c) await c.end().catch(() => undefined);
  }

  isConnected(): boolean {
    return !!this.conn;
  }

  defaultDatabase(): string {
    return this.config.database || '';
  }

  protected async run(sql: string, database: string, maxRows?: number): Promise<QueryResult> {
    if (!this.conn) throw new Error('No hay conexión activa.');
    if (database && database !== this.currentDb) {
      await this.conn.query(`USE ${this.quoteIdent(database)}`);
      this.currentDb = database;
    }
    const [result, fieldsRaw] = await this.conn.query({ sql, rowsAsArray: true } as any) as any;
    if (/^\s*use\s/i.test(sql)) this.currentDb = sql.replace(/^\s*use\s+/i, '').replace(/[`;\s]/g, '');
    let rows: any[] = [];
    let fields: any[] | undefined = fieldsRaw;
    if (Array.isArray(fieldsRaw) && Array.isArray(fieldsRaw[0])) {
      // CALL con varios result sets: se toma el primero
      const idx = fieldsRaw.findIndex((f: any) => Array.isArray(f));
      fields = fieldsRaw[idx];
      rows = result[idx];
    } else if (Array.isArray(result)) {
      rows = result;
    } else {
      return { columns: [], rows: [], affectedRows: result?.affectedRows ?? 0, durationMs: 0, message: result?.info || undefined };
    }
    let truncated = false;
    if (maxRows && rows.length > maxRows) { rows = rows.slice(0, maxRows); truncated = true; }
    return {
      columns: (fields ?? []).map((f: any) => ({ name: f.name, type: MYSQL_TYPES[f.columnType ?? f.type] ?? String(f.columnType ?? '') })),
      rows,
      durationMs: 0,
      truncated
    };
  }

  quoteIdent(name: string): string {
    return '`' + name.replace(/`/g, '``') + '`';
  }

  str(v: string): string {
    return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  }

  qualified(ref: TableRef): string {
    return ref.database ? `${this.quoteIdent(ref.database)}.${this.quoteIdent(ref.name)}` : this.quoteIdent(ref.name);
  }

  insertDefaultSql(ref: TableRef): string {
    return `INSERT INTO ${this.qualified(ref)} () VALUES ()`;
  }

  versionSql(): string {
    return 'SELECT VERSION()';
  }

  sessionsSql(): string {
    return 'SHOW FULL PROCESSLIST';
  }

  async explain(sql: string, database?: string): Promise<QueryResult> {
    return this.execute('EXPLAIN ' + sql, database);
  }

  async listDatabases(): Promise<string[]> {
    const r = await this.rows('SHOW DATABASES', '');
    const names = r.map(x => String(Object.values(x)[0]));
    return this.config.showSystemObjects ? names : names.filter(n => !SYSTEM_DBS.has(n.toLowerCase()));
  }

  async listSchemas(): Promise<string[]> {
    return [];
  }

  async listObjects(database: string, _schema: string | undefined, kind: ObjectKind): Promise<ObjectRef[]> {
    const s = this.str(database);
    let sql: string;
    if (kind === 'table' || kind === 'view') {
      sql = `SELECT TABLE_NAME AS name, TABLE_COMMENT AS cmt FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ${s} AND TABLE_TYPE ${kind === 'table' ? `IN ('BASE TABLE','SYSTEM VERSIONED')` : `= 'VIEW'`} ORDER BY TABLE_NAME`;
    } else if (kind === 'function' || kind === 'procedure') {
      sql = `SELECT ROUTINE_NAME AS name, ROUTINE_COMMENT AS cmt FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = ${s} AND ROUTINE_TYPE = '${kind.toUpperCase()}' ORDER BY ROUTINE_NAME`;
    } else {
      return [];
    }
    const r = await this.rows(sql, '');
    return r.map(x => ({ database, name: x.name, kind, comment: x.cmt || undefined }));
  }

  async listColumns(ref: TableRef): Promise<ColumnInfo[]> {
    const r = await this.rows(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS data_type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt,
  COLUMN_KEY AS ckey, EXTRA AS extra, COLUMN_COMMENT AS cmt, ORDINAL_POSITION AS ord
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${this.str(ref.database)} AND TABLE_NAME = ${this.str(ref.name)}
ORDER BY ORDINAL_POSITION`, '');
    return r.map(x => ({
      name: x.name,
      dataType: x.data_type,
      nullable: x.nullable === 'YES',
      defaultValue: x.dflt,
      isPrimaryKey: x.ckey === 'PRI',
      isAutoIncrement: /auto_increment/i.test(x.extra ?? ''),
      extra: x.extra || undefined,
      comment: x.cmt || undefined,
      ordinal: Number(x.ord)
    }));
  }

  async listIndexes(ref: TableRef): Promise<IndexInfo[]> {
    const r = await this.rows(`SELECT INDEX_NAME AS name, CASE WHEN NON_UNIQUE = 0 THEN 1 ELSE 0 END AS uq,
  CASE WHEN INDEX_NAME = 'PRIMARY' THEN 1 ELSE 0 END AS pk, COLUMN_NAME AS col
FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ${this.str(ref.database)} AND TABLE_NAME = ${this.str(ref.name)}
ORDER BY INDEX_NAME, SEQ_IN_INDEX`, '');
    return this.groupIndexes(r);
  }

  async listForeignKeys(ref: TableRef): Promise<ForeignKeyInfo[]> {
    const r = await this.rows(`SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS rs,
  k.REFERENCED_TABLE_NAME AS rt, k.REFERENCED_COLUMN_NAME AS rc, r.UPDATE_RULE AS ur, r.DELETE_RULE AS dr
FROM information_schema.KEY_COLUMN_USAGE k
JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
WHERE k.TABLE_SCHEMA = ${this.str(ref.database)} AND k.TABLE_NAME = ${this.str(ref.name)} AND k.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, '');
    // En MySQL el "esquema" de referencia es otra base de datos
    return this.groupForeignKeys(r).map(fk => ({ ...fk, refSchema: undefined }));
  }

  async listTriggers(ref: TableRef): Promise<ObjectRef[]> {
    const r = await this.rows(`SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
WHERE EVENT_OBJECT_SCHEMA = ${this.str(ref.database)} AND EVENT_OBJECT_TABLE = ${this.str(ref.name)} ORDER BY TRIGGER_NAME`, '');
    return r.map(x => ({ database: ref.database, name: x.name, kind: 'trigger' as ObjectKind, parent: ref.name }));
  }

  async getDDL(ref: ObjectRef): Promise<string> {
    const qn = this.qualified(ref);
    const stmt: Record<ObjectKind, string> = {
      table: `SHOW CREATE TABLE ${qn}`, view: `SHOW CREATE VIEW ${qn}`, matview: `SHOW CREATE VIEW ${qn}`,
      function: `SHOW CREATE FUNCTION ${qn}`, procedure: `SHOW CREATE PROCEDURE ${qn}`, trigger: `SHOW CREATE TRIGGER ${qn}`,
      sequence: `SHOW CREATE SEQUENCE ${qn}`
    };
    const r = await this.run(stmt[ref.kind], '');
    const idx = r.columns.findIndex(c => /^(create (table|view|function|procedure|sequence)|sql original statement)$/i.test(c.name));
    const ddl = String(r.rows[0]?.[idx >= 0 ? idx : 1] ?? '');
    if (ref.kind === 'function' || ref.kind === 'procedure' || ref.kind === 'trigger') {
      return `DELIMITER $$\n${ddl}$$\nDELIMITER ;\n`;
    }
    let out = ddl + ';\n';
    if (ref.kind === 'table') {
      for (const t of await this.listTriggers(ref)) {
        out += '\n' + (await this.getDDL(t));
      }
    }
    return out;
  }

  async searchObjects(pattern: string): Promise<ObjectRef[]> {
    const like = this.str(`%${pattern}%`);
    const sys = this.config.showSystemObjects ? '' : `AND TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys')`;
    const t = await this.rows(`SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, TABLE_TYPE AS t FROM information_schema.TABLES
WHERE TABLE_NAME LIKE ${like} ${sys} ORDER BY 1, 2 LIMIT 300`, '');
    const r = await this.rows(`SELECT ROUTINE_SCHEMA AS db, ROUTINE_NAME AS name, ROUTINE_TYPE AS t FROM information_schema.ROUTINES
WHERE ROUTINE_NAME LIKE ${like} ${sys.replace(/TABLE_SCHEMA/g, 'ROUTINE_SCHEMA')} ORDER BY 1, 2 LIMIT 200`, '');
    return [
      ...t.map(x => ({ database: x.db, name: x.name, kind: (x.t === 'VIEW' ? 'view' : 'table') as ObjectKind })),
      ...r.map(x => ({ database: x.db, name: x.name, kind: (x.t === 'PROCEDURE' ? 'procedure' : 'function') as ObjectKind }))
    ];
  }

  dropSchemaSql(name: string): string {
    return this.dropDatabaseSql(name);
  }

  newTableTemplate(database: string): string {
    const t = this.qualified({ database, name: 'nueva_tabla' });
    return `CREATE TABLE ${t} (\n  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  nombre VARCHAR(100) NOT NULL,\n  creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n`;
  }
}
