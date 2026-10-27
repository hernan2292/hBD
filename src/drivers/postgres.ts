import { Client, types } from 'pg';
import { BaseDriver, TableRef } from './base';
import { Capabilities, ColumnInfo, ForeignKeyInfo, IndexInfo, ObjectKind, ObjectRef, QueryResult, SqlDialect } from './types';

const RAW_STRING_OIDS = new Set([1082, 1083, 1114, 1184, 1266, 1186]);
const PG_TYPES: Record<number, string> = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 26: 'oid',
  114: 'json', 142: 'xml', 700: 'float4', 701: 'float8', 790: 'money', 869: 'inet', 1042: 'bpchar', 1043: 'varchar',
  1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval', 1266: 'timetz',
  1560: 'bit', 1562: 'varbit', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb', 1009: 'text[]', 1007: 'int4[]', 1016: 'int8[]'
};

const customTypes = {
  getTypeParser: (oid: number, format?: any) =>
    RAW_STRING_OIDS.has(oid) ? ((v: string) => v) : (types.getTypeParser as any)(oid, format)
};

const SYSTEM_SCHEMAS = `('pg_catalog','information_schema')`;

export class PostgresDriver extends BaseDriver {
  readonly dialect: SqlDialect = 'postgresql';
  readonly caps: Capabilities = {
    schemas: true,
    kinds: ['table', 'view', 'matview', 'function', 'procedure', 'sequence'],
    createDatabase: true,
    createSchema: true
  };
  private clients = new Map<string, Client>();
  private connecting = new Map<string, Promise<Client>>();
  private password: string | undefined;
  private connected = false;

  async connect(password: string | undefined): Promise<void> {
    this.password = password;
    await this.client(this.defaultDatabase());
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    const all = [...this.clients.values()];
    this.clients.clear();
    this.openTx.clear();
    await Promise.all(all.map(c => c.end().catch(() => undefined)));
  }

  isConnected(): boolean {
    return this.connected;
  }

  defaultDatabase(): string {
    return this.config.database || 'postgres';
  }

  defaultSchema(): string {
    return 'public';
  }

  async releaseDatabase(database: string): Promise<void> {
    const c = this.clients.get(database);
    this.clients.delete(database);
    this.openTx.delete(database);
    if (c) await c.end().catch(() => undefined);
  }

  private client(db: string): Promise<Client> {
    const existing = this.clients.get(db);
    if (existing) return Promise.resolve(existing);
    let p = this.connecting.get(db);
    if (!p) {
      p = (async () => {
        const c = new Client({
          host: this.config.host || 'localhost',
          port: this.config.port || 5432,
          user: this.config.user,
          password: this.password,
          database: db,
          ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
          application_name: 'hBD',
          types: customTypes as any
        });
        c.on('error', () => { this.clients.delete(db); this.openTx.delete(db); });
        c.on('end', () => { this.clients.delete(db); this.openTx.delete(db); });
        await c.connect();
        if (this.config.readOnly) await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
        this.clients.set(db, c);
        return c;
      })().finally(() => this.connecting.delete(db));
      this.connecting.set(db, p);
    }
    return p;
  }

  protected async run(sql: string, database: string, maxRows?: number): Promise<QueryResult> {
    const c = await this.client(database);
    const res: any = await c.query({ text: sql, rowMode: 'array' } as any);
    const last = Array.isArray(res) ? res[res.length - 1] : res;
    const fields: any[] = last?.fields ?? [];
    let rows: unknown[][] = last?.rows ?? [];
    let truncated = false;
    if (maxRows && rows.length > maxRows) {
      rows = rows.slice(0, maxRows);
      truncated = true;
    }
    return {
      columns: fields.map(f => ({ name: f.name, type: PG_TYPES[f.dataTypeID] ?? String(f.dataTypeID) })),
      rows,
      affectedRows: fields.length ? undefined : (last?.rowCount ?? undefined),
      command: last?.command,
      durationMs: 0,
      truncated
    };
  }

  quoteIdent(name: string): string {
    return /^[a-z_][a-z0-9_]*$/.test(name) && !PG_RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
  }

  literal(v: unknown): string {
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return super.literal(v);
  }

  str(v: string): string {
    return v.includes('\\') ? `E'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'` : `'${v.replace(/'/g, "''")}'`;
  }

  versionSql(): string {
    return 'SELECT version()';
  }

  sessionsSql(): string {
    return `SELECT pid, usename, datname, application_name, client_addr, state, backend_start, query_start, wait_event_type, wait_event, query
FROM pg_stat_activity ORDER BY pid`;
  }

  async explain(sql: string, database?: string): Promise<QueryResult> {
    return this.execute('EXPLAIN (VERBOSE, COSTS) ' + sql, database);
  }

  async listDatabases(): Promise<string[]> {
    const r = await this.rows(`SELECT datname AS name FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY 1`);
    return r.map(x => x.name);
  }

  async listSchemas(database: string): Promise<string[]> {
    const sys = this.config.showSystemObjects ? '' : ` AND nspname NOT IN ${SYSTEM_SCHEMAS}`;
    const r = await this.rows(`SELECT nspname AS name FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%'${sys} ORDER BY 1`, database);
    return r.map(x => x.name);
  }

  async listObjects(database: string, schema: string | undefined, kind: ObjectKind): Promise<ObjectRef[]> {
    const s = this.str(schema ?? 'public');
    const relkinds: Partial<Record<ObjectKind, string>> = { table: `'r','p','f'`, view: `'v'`, matview: `'m'`, sequence: `'S'` };
    if (relkinds[kind]) {
      const r = await this.rows(`SELECT c.oid::text AS id, c.relname AS name, obj_description(c.oid, 'pg_class') AS cmt
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ${s} AND c.relkind IN (${relkinds[kind]}) ORDER BY 2`, database);
      return r.map(x => ({ database, schema, name: x.name, kind, id: x.id, comment: x.cmt ?? undefined }));
    }
    if (kind === 'function' || kind === 'procedure') {
      const pk = kind === 'function' ? `p.prokind IN ('f','w')` : `p.prokind = 'p'`;
      const r = await this.rows(`SELECT p.oid::text AS id, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = ${s} AND ${pk} ORDER BY 2, 3`, database);
      return r.map(x => ({ database, schema, name: x.name, kind, id: x.id, signature: x.args ?? '' }));
    }
    return [];
  }

  async listColumns(ref: TableRef): Promise<ColumnInfo[]> {
    const r = await this.rows(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS data_type, NOT a.attnotnull AS nullable,
  pg_get_expr(d.adbin, d.adrelid) AS dflt, col_description(a.attrelid, a.attnum) AS cmt, a.attnum AS ord, a.attidentity AS ident,
  EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = ${this.str(ref.schema ?? 'public')} AND c.relname = ${this.str(ref.name)} AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`, ref.database);
    return r.map(x => ({
      name: x.name,
      dataType: x.data_type,
      nullable: !!x.nullable,
      defaultValue: x.dflt,
      isPrimaryKey: !!x.pk,
      isAutoIncrement: (x.ident && x.ident !== '') || /^nextval\(/.test(x.dflt ?? ''),
      extra: x.ident === 'a' ? 'GENERATED ALWAYS AS IDENTITY' : x.ident === 'd' ? 'GENERATED BY DEFAULT AS IDENTITY' : undefined,
      comment: x.cmt,
      ordinal: Number(x.ord)
    }));
  }

  async listIndexes(ref: TableRef): Promise<IndexInfo[]> {
    const r = await this.rows(`SELECT i.relname AS name, ix.indisunique AS uq, ix.indisprimary AS pk, pg_get_indexdef(ix.indexrelid) AS def,
  ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true) FROM generate_subscripts(ix.indkey, 1) AS k ORDER BY k) AS cols
FROM pg_index ix
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = ${this.str(ref.schema ?? 'public')} AND t.relname = ${this.str(ref.name)}
ORDER BY 1`, ref.database);
    return r.map(x => ({ name: x.name, unique: !!x.uq, primary: !!x.pk, definition: x.def, columns: toArray(x.cols) }));
  }

  async listForeignKeys(ref: TableRef): Promise<ForeignKeyInfo[]> {
    const r = await this.rows(`SELECT con.conname AS name, nf.nspname AS rs, cf.relname AS rt,
  ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o)::text[] AS cols,
  ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o)::text[] AS rcols,
  CASE con.confupdtype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END AS ur,
  CASE con.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END AS dr
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_class cf ON cf.oid = con.confrelid JOIN pg_namespace nf ON nf.oid = cf.relnamespace
WHERE con.contype = 'f' AND n.nspname = ${this.str(ref.schema ?? 'public')} AND c.relname = ${this.str(ref.name)}
ORDER BY 1`, ref.database);
    return r.map(x => ({
      name: x.name, refSchema: x.rs, refTable: x.rt, columns: toArray(x.cols), refColumns: toArray(x.rcols), onUpdate: x.ur, onDelete: x.dr
    }));
  }

  async listTriggers(ref: TableRef): Promise<ObjectRef[]> {
    const r = await this.rows(`SELECT t.oid::text AS id, t.tgname AS name FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname = ${this.str(ref.schema ?? 'public')} AND c.relname = ${this.str(ref.name)} ORDER BY 2`, ref.database);
    return r.map(x => ({ database: ref.database, schema: ref.schema, name: x.name, kind: 'trigger' as ObjectKind, id: x.id, parent: ref.name }));
  }

  async getDDL(ref: ObjectRef): Promise<string> {
    const qn = this.qualified(ref);
    const db = ref.database;
    const regclass = `${this.str(qn)}::regclass`;
    switch (ref.kind) {
      case 'table': return this.tableDDL(ref);
      case 'view': {
        const r = await this.rows(`SELECT pg_get_viewdef(${regclass}, true) AS def`, db);
        return `CREATE OR REPLACE VIEW ${qn} AS\n${r[0]?.def ?? ''}`;
      }
      case 'matview': {
        const r = await this.rows(`SELECT pg_get_viewdef(${regclass}, true) AS def`, db);
        return `CREATE MATERIALIZED VIEW ${qn} AS\n${r[0]?.def ?? ''}`;
      }
      case 'function':
      case 'procedure': {
        const r = await this.rows(`SELECT pg_get_functiondef(${Number(ref.id)}) AS def`, db);
        return String(r[0]?.def ?? '');
      }
      case 'trigger': {
        const r = await this.rows(`SELECT pg_get_triggerdef(${Number(ref.id)}, true) AS def`, db);
        return String(r[0]?.def ?? '') + ';';
      }
      case 'sequence': {
        const r = await this.rows(`SELECT data_type, start_value, min_value, max_value, increment_by, cycle, cache_size FROM pg_sequences
WHERE schemaname = ${this.str(ref.schema ?? 'public')} AND sequencename = ${this.str(ref.name)}`, db);
        const s = r[0];
        if (!s) return `CREATE SEQUENCE ${qn};`;
        return `CREATE SEQUENCE ${qn}\n  AS ${s.data_type}\n  INCREMENT BY ${s.increment_by}\n  MINVALUE ${s.min_value}\n  MAXVALUE ${s.max_value}\n  START WITH ${s.start_value}\n  CACHE ${s.cache_size}\n  ${s.cycle ? 'CYCLE' : 'NO CYCLE'};`;
      }
    }
  }

  private async tableDDL(ref: ObjectRef): Promise<string> {
    const db = ref.database;
    const qn = this.qualified(ref);
    const cols = await this.listColumns(ref);
    const oidRow = await this.rows(`SELECT ${this.str(qn)}::regclass::oid AS oid, obj_description(${this.str(qn)}::regclass, 'pg_class') AS cmt`, db);
    const oid = Number(oidRow[0]?.oid);
    const cons = await this.rows(`SELECT conname AS name, pg_get_constraintdef(oid, true) AS def FROM pg_constraint
WHERE conrelid = ${oid} ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 ELSE 3 END, conname`, db);
    const idx = await this.rows(`SELECT pg_get_indexdef(indexrelid) AS def FROM pg_index
WHERE indrelid = ${oid} AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = pg_index.indexrelid AND c.conrelid = ${oid})`, db);
    const trg = await this.rows(`SELECT pg_get_triggerdef(oid, true) AS def FROM pg_trigger WHERE tgrelid = ${oid} AND NOT tgisinternal`, db);
    const lines = cols.map(c => {
      const dflt = c.extra ? ` ${c.extra}` : c.defaultValue != null ? ` DEFAULT ${c.defaultValue}` : '';
      return `  ${this.quoteIdent(c.name)} ${c.dataType}${dflt}${c.nullable ? '' : ' NOT NULL'}`;
    });
    for (const c of cons) lines.push(`  CONSTRAINT ${this.quoteIdent(c.name)} ${c.def}`);
    let out = `CREATE TABLE ${qn} (\n${lines.join(',\n')}\n);\n`;
    for (const i of idx) out += `\n${i.def};`;
    if (oidRow[0]?.cmt) out += `\n\nCOMMENT ON TABLE ${qn} IS ${this.str(oidRow[0].cmt)};`;
    for (const c of cols.filter(x => x.comment)) out += `\nCOMMENT ON COLUMN ${qn}.${this.quoteIdent(c.name)} IS ${this.str(String(c.comment))};`;
    for (const t of trg) out += `\n\n${t.def};`;
    return out + '\n';
  }

  async searchObjects(pattern: string): Promise<ObjectRef[]> {
    const db = this.defaultDatabase();
    const like = this.str(`%${pattern}%`);
    const rels = await this.rows(`SELECT c.oid::text AS id, n.nspname AS sch, c.relname AS name, c.relkind AS k
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p','v','m','S','f') AND c.relname ILIKE ${like} AND n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY 2, 3 LIMIT 300`, db);
    const fns = await this.rows(`SELECT p.oid::text AS id, n.nspname AS sch, p.proname AS name, p.prokind AS k, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname ILIKE ${like} AND n.nspname NOT IN ${SYSTEM_SCHEMAS} ORDER BY 2, 3 LIMIT 200`, db);
    const kindOf: Record<string, ObjectKind> = { r: 'table', p: 'table', f: 'table', v: 'view', m: 'matview', S: 'sequence' };
    return [
      ...rels.map(x => ({ database: db, schema: x.sch, name: x.name, kind: kindOf[x.k], id: x.id })),
      ...fns.map(x => ({ database: db, schema: x.sch, name: x.name, kind: (x.k === 'p' ? 'procedure' : 'function') as ObjectKind, id: x.id, signature: x.args }))
    ];
  }

  dropSql(ref: ObjectRef): string {
    if (ref.kind === 'function' || ref.kind === 'procedure') {
      return `DROP ${ref.kind === 'function' ? 'FUNCTION' : 'PROCEDURE'} ${this.qualified(ref)}(${ref.signature ?? ''})`;
    }
    if (ref.kind === 'trigger') {
      return `DROP TRIGGER ${this.quoteIdent(ref.name)} ON ${this.qualified({ database: ref.database, schema: ref.schema, name: ref.parent ?? '' })}`;
    }
    return super.dropSql(ref);
  }

  newTableTemplate(database: string, schema: string | undefined): string {
    const t = this.qualified({ database, schema: schema ?? 'public', name: 'nueva_tabla' });
    return `CREATE TABLE ${t} (\n  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,\n  nombre VARCHAR(100) NOT NULL,\n  creado TIMESTAMPTZ NOT NULL DEFAULT now()\n);\n`;
  }
}

function toArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.replace(/^\{|\}$/g, '').split(',').filter(Boolean).map(s => s.replace(/^"|"$/g, ''));
  return [];
}

const PG_RESERVED = new Set(['all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'both', 'case', 'cast', 'check',
  'collate', 'column', 'constraint', 'create', 'current_date', 'current_role', 'current_time', 'current_timestamp', 'current_user', 'default',
  'deferrable', 'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in',
  'initially', 'intersect', 'into', 'lateral', 'leading', 'limit', 'localtime', 'localtimestamp', 'not', 'null', 'offset', 'on', 'only', 'or',
  'order', 'placing', 'primary', 'references', 'returning', 'select', 'session_user', 'some', 'symmetric', 'table', 'then', 'to', 'trailing',
  'true', 'union', 'unique', 'user', 'using', 'variadic', 'when', 'where', 'window', 'with', 'authorization', 'binary', 'collation',
  'concurrently', 'cross', 'current_schema', 'freeze', 'full', 'ilike', 'inner', 'is', 'isnull', 'join', 'left', 'like', 'natural', 'notnull',
  'outer', 'overlaps', 'right', 'similar', 'tablesample', 'verbose', 'user', 'order', 'group']);
