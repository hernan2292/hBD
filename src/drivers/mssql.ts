import * as mssql from 'mssql';
import { BaseDriver, TableRef } from './base';
import { Capabilities, ColumnInfo, ConnectionConfig, ForeignKeyInfo, IndexInfo, ObjectKind, ObjectRef, QueryResult, SqlDialect } from './types';

const SYSTEM_DBS = `('master','tempdb','model','msdb')`;

export class MsSqlDriver extends BaseDriver {
  readonly dialect: SqlDialect = 'transactsql';
  readonly caps: Capabilities = {
    schemas: true,
    kinds: ['table', 'view', 'function', 'procedure', 'sequence'],
    createDatabase: true,
    createSchema: true
  };
  private pool: mssql.ConnectionPool | undefined;
  private currentDb = '';

  constructor(config: ConnectionConfig) {
    super(config);
    this.beginSql = 'BEGIN TRANSACTION';
    this.commitSql = 'COMMIT TRANSACTION';
    this.rollbackSql = 'ROLLBACK TRANSACTION';
  }

  async connect(password: string | undefined): Promise<void> {
    const pool = new mssql.ConnectionPool({
      server: this.config.host || 'localhost',
      port: this.config.port || 1433,
      user: this.config.user,
      password,
      database: this.config.database || undefined,
      requestTimeout: 0,
      connectionTimeout: 15000,
      options: {
        encrypt: !!this.config.ssl,
        trustServerCertificate: this.config.trustServerCertificate ?? true,
        enableArithAbort: true,
        appName: 'hBD'
      },
      // Una única conexión física para conservar USE, #temporales y transacciones
      pool: { max: 1, min: 1, idleTimeoutMillis: 2147483647 }
    });
    pool.on('error', () => { this.openTx.clear(); });
    await pool.connect();
    this.pool = pool;
    const r = await pool.request().batch('SELECT DB_NAME() AS db');
    this.currentDb = String((r.recordset?.[0] as any)?.db ?? '');
  }

  async disconnect(): Promise<void> {
    const p = this.pool;
    this.pool = undefined;
    this.openTx.clear();
    if (p) await p.close().catch(() => undefined);
  }

  isConnected(): boolean {
    return !!this.pool?.connected;
  }

  defaultDatabase(): string {
    return this.config.database || this.currentDb || 'master';
  }

  defaultSchema(): string {
    return 'dbo';
  }

  protected async run(sql: string, database: string, maxRows?: number): Promise<QueryResult> {
    if (!this.pool) throw new Error('No hay conexión activa.');
    if (database && database !== this.currentDb) {
      await this.pool.request().batch(`USE ${this.quoteIdent(database)}`);
      this.currentDb = database;
    }
    const req = this.pool.request();
    (req as any).arrayRowMode = true;
    const r: any = await req.batch(sql);
    if (/^\s*use\s/i.test(sql)) {
      const now = await this.pool.request().batch('SELECT DB_NAME() AS db');
      this.currentDb = String((now.recordset?.[0] as any)?.db ?? this.currentDb);
    }
    const sets: any[] = r.recordsets ?? [];
    const colSets: any[] = r.columns ?? [];
    const affected = Array.isArray(r.rowsAffected) ? r.rowsAffected.reduce((a: number, b: number) => a + b, 0) : undefined;
    if (!sets.length) return { columns: [], rows: [], affectedRows: affected ?? 0, durationMs: 0 };
    const idx = 0;
    let rows: unknown[][] = sets[idx] ?? [];
    const meta: any[] = colSets[idx] ?? Object.values(sets[idx]?.columns ?? {}).sort((a: any, b: any) => a.index - b.index);
    let truncated = false;
    if (maxRows && rows.length > maxRows) { rows = rows.slice(0, maxRows); truncated = true; }
    return {
      columns: meta.map(c => ({ name: c.name || '(sin nombre)', type: c.type?.declaration ?? c.type?.name })),
      rows,
      durationMs: 0,
      truncated,
      message: sets.length > 1 ? `Se devolvieron ${sets.length} conjuntos de resultados; se muestra el primero.` : undefined
    };
  }

  quoteIdent(name: string): string {
    return `[${name.replace(/]/g, ']]')}]`;
  }

  str(v: string): string {
    return `N'${v.replace(/'/g, "''")}'`;
  }

  versionSql(): string {
    return 'SELECT @@VERSION';
  }

  sessionsSql(): string {
    return `SELECT s.session_id, s.login_name, s.host_name, s.program_name, s.status, DB_NAME(s.database_id) AS database_name,
  s.login_time, s.last_request_start_time, r.command, r.wait_type, t.text AS sql_text
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE s.is_user_process = 1 ORDER BY s.session_id`;
  }

  async explain(sql: string, database?: string): Promise<QueryResult> {
    const db = database || this.defaultDatabase();
    await this.run('SET SHOWPLAN_TEXT ON', db);
    try {
      const start = Date.now();
      const r = await this.run(sql, db);
      r.durationMs = Date.now() - start;
      return r;
    } finally {
      await this.run('SET SHOWPLAN_TEXT OFF', db);
    }
  }

  selectPageSql(ref: TableRef, where: string, orderBy: string, limit: number, offset: number): string {
    return `SELECT * FROM ${this.qualified(ref)}${where ? ` WHERE ${where}` : ''} ORDER BY ${orderBy || '(SELECT NULL)'} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }

  async listDatabases(): Promise<string[]> {
    const sys = this.config.showSystemObjects ? '' : ` AND name NOT IN ${SYSTEM_DBS}`;
    const r = await this.rows(`SELECT name FROM sys.databases WHERE state = 0${sys} ORDER BY name`, this.currentDb);
    return r.map(x => x.name);
  }

  async listSchemas(database: string): Promise<string[]> {
    const sys = this.config.showSystemObjects ? '' : ` AND name NOT IN ('sys','INFORMATION_SCHEMA','guest') AND name NOT LIKE 'db[_]%'`;
    const r = await this.rows(`SELECT name FROM sys.schemas WHERE 1 = 1${sys} ORDER BY name`, database);
    return r.map(x => x.name);
  }

  async listObjects(database: string, schema: string | undefined, kind: ObjectKind): Promise<ObjectRef[]> {
    const s = this.str(schema ?? 'dbo');
    const src: Partial<Record<ObjectKind, string>> = {
      table: `sys.tables`, view: `sys.views`, procedure: `sys.procedures`, sequence: `sys.sequences`,
      function: `(SELECT * FROM sys.objects WHERE type IN ('FN','IF','TF','FS','FT'))`
    };
    if (!src[kind]) return [];
    const r = await this.rows(`SELECT o.name FROM ${src[kind]} o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = ${s} ORDER BY o.name`, database);
    return r.map(x => ({ database, schema, name: x.name, kind }));
  }

  private objId(ref: TableRef): string {
    return `OBJECT_ID(${this.str(this.qualified(ref))})`;
  }

  async listColumns(ref: TableRef): Promise<ColumnInfo[]> {
    const r = await this.rows(`SELECT c.name, TYPE_NAME(c.user_type_id) +
  CASE WHEN TYPE_NAME(c.user_type_id) IN ('varchar','char','varbinary','binary') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
       WHEN TYPE_NAME(c.user_type_id) IN ('nvarchar','nchar') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
       WHEN TYPE_NAME(c.user_type_id) IN ('decimal','numeric') THEN '(' + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')'
       WHEN TYPE_NAME(c.user_type_id) IN ('datetime2','time','datetimeoffset') THEN '(' + CAST(c.scale AS varchar(10)) + ')'
       ELSE '' END AS data_type,
  c.is_nullable AS nullable, OBJECT_DEFINITION(c.default_object_id) AS dflt, c.is_identity AS ident, c.column_id AS ord,
  CAST(ep.value AS nvarchar(4000)) AS cmt,
  CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                    WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS pk
FROM sys.columns c
LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
WHERE c.object_id = ${this.objId(ref)} ORDER BY c.column_id`, ref.database);
    return r.map(x => ({
      name: x.name,
      dataType: x.data_type,
      nullable: !!x.nullable,
      defaultValue: x.dflt,
      isPrimaryKey: !!x.pk,
      isAutoIncrement: !!x.ident,
      extra: x.ident ? 'IDENTITY' : undefined,
      comment: x.cmt,
      ordinal: Number(x.ord)
    }));
  }

  protected identityClause(c: ColumnInfo): string {
    return c.isAutoIncrement ? ' IDENTITY(1,1)' : '';
  }

  async listIndexes(ref: TableRef): Promise<IndexInfo[]> {
    const r = await this.rows(`SELECT i.name, CAST(i.is_unique AS int) AS uq, CAST(i.is_primary_key AS int) AS pk, c.name AS col
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.object_id = ${this.objId(ref)} AND i.name IS NOT NULL AND ic.is_included_column = 0
ORDER BY i.name, ic.key_ordinal`, ref.database);
    return this.groupIndexes(r);
  }

  async listForeignKeys(ref: TableRef): Promise<ForeignKeyInfo[]> {
    const r = await this.rows(`SELECT fk.name, c1.name AS col, SCHEMA_NAME(rt.schema_id) AS rs, rt.name AS rt, c2.name AS rc,
  fk.update_referential_action_desc AS ur, fk.delete_referential_action_desc AS dr
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns c1 ON c1.object_id = fkc.parent_object_id AND c1.column_id = fkc.parent_column_id
JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
JOIN sys.columns c2 ON c2.object_id = fkc.referenced_object_id AND c2.column_id = fkc.referenced_column_id
WHERE fk.parent_object_id = ${this.objId(ref)} ORDER BY fk.name, fkc.constraint_column_id`, ref.database);
    return this.groupForeignKeys(r);
  }

  async listTriggers(ref: TableRef): Promise<ObjectRef[]> {
    const r = await this.rows(`SELECT name FROM sys.triggers WHERE parent_id = ${this.objId(ref)} ORDER BY name`, ref.database);
    return r.map(x => ({ database: ref.database, schema: ref.schema, name: x.name, kind: 'trigger' as ObjectKind, parent: ref.name }));
  }

  async getDDL(ref: ObjectRef): Promise<string> {
    if (ref.kind === 'table') {
      let out = await this.genericTableDDL(ref);
      for (const t of await this.listTriggers(ref)) out += '\nGO\n' + (await this.getDDL(t));
      return out;
    }
    if (ref.kind === 'sequence') {
      const r = await this.rows(`SELECT TYPE_NAME(user_type_id) AS t, start_value, increment, minimum_value, maximum_value, is_cycling
FROM sys.sequences WHERE object_id = ${this.objId(ref)}`, ref.database);
      const s = r[0];
      if (!s) return '';
      return `CREATE SEQUENCE ${this.qualified(ref)}\n  AS ${s.t}\n  START WITH ${s.start_value}\n  INCREMENT BY ${s.increment}\n  MINVALUE ${s.minimum_value}\n  MAXVALUE ${s.maximum_value}\n  ${s.is_cycling ? 'CYCLE' : 'NO CYCLE'};`;
    }
    const r = await this.rows(`SELECT OBJECT_DEFINITION(${this.objId(ref)}) AS def`, ref.database);
    return String(r[0]?.def ?? '').trim() + '\nGO\n';
  }

  async searchObjects(pattern: string): Promise<ObjectRef[]> {
    const db = this.defaultDatabase();
    const r = await this.rows(`SELECT TOP 500 SCHEMA_NAME(schema_id) AS sch, name, RTRIM(type) AS t FROM sys.objects
WHERE type IN ('U','V','P','FN','IF','TF','SO') AND name LIKE ${this.str(`%${pattern}%`)} ORDER BY name`, db);
    const map: Record<string, ObjectKind> = { U: 'table', V: 'view', P: 'procedure', FN: 'function', IF: 'function', TF: 'function', SO: 'sequence' };
    return r.map(x => ({ database: db, schema: x.sch, name: x.name, kind: map[x.t] ?? 'table' }));
  }

  newTableTemplate(database: string, schema: string | undefined): string {
    const t = this.qualified({ database, schema: schema ?? 'dbo', name: 'nueva_tabla' });
    return `CREATE TABLE ${t} (\n  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,\n  nombre NVARCHAR(100) NOT NULL,\n  creado DATETIME2 NOT NULL DEFAULT SYSDATETIME()\n);\n`;
  }
}
