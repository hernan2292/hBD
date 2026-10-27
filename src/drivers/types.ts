export type DriverType = 'postgres' | 'mysql' | 'mariadb' | 'mssql' | 'sqlite';

export const DRIVER_LABELS: Record<DriverType, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  mssql: 'SQL Server',
  sqlite: 'SQLite'
};

export const DEFAULT_PORTS: Record<DriverType, number | undefined> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  mssql: 1433,
  sqlite: undefined
};

export interface SshConfig {
  enabled: boolean;
  host: string;
  port?: number;
  user: string;
  authType: 'password' | 'key';
  privateKeyPath?: string;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  driver: DriverType;
  group?: string;
  color?: string;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  filePath?: string;
  ssl?: boolean;
  trustServerCertificate?: boolean;
  readOnly?: boolean;
  savePassword?: boolean;
  showSystemObjects?: boolean;
  ssh?: SshConfig;
}

export interface ResultColumn {
  name: string;
  type?: string;
}

export interface QueryResult {
  columns: ResultColumn[];
  rows: unknown[][];
  affectedRows?: number;
  command?: string;
  durationMs: number;
  truncated?: boolean;
  message?: string;
}

export type ObjectKind = 'table' | 'view' | 'matview' | 'function' | 'procedure' | 'sequence' | 'trigger';

export const KIND_LABELS: Record<ObjectKind, string> = {
  table: 'Tablas',
  view: 'Vistas',
  matview: 'Vistas materializadas',
  function: 'Funciones',
  procedure: 'Procedimientos',
  sequence: 'Secuencias',
  trigger: 'Triggers'
};

export interface ObjectRef {
  database: string;
  schema?: string;
  name: string;
  kind: ObjectKind;
  /** Firma de argumentos (funciones PostgreSQL) */
  signature?: string;
  /** Identificador interno (oid en PostgreSQL) */
  id?: string;
  /** Tabla a la que pertenece (triggers) */
  parent?: string;
  comment?: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: string | null;
  isPrimaryKey: boolean;
  isAutoIncrement?: boolean;
  /** Información adicional específica del motor (identity, extra, etc.) */
  extra?: string;
  comment?: string | null;
  ordinal: number;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  definition?: string;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onUpdate?: string;
  onDelete?: string;
}

export interface Capabilities {
  /** El motor tiene esquemas dentro de cada base de datos */
  schemas: boolean;
  /** Tipos de objeto que se listan dentro de un esquema / base */
  kinds: ObjectKind[];
  createDatabase: boolean;
  createSchema: boolean;
}

export type SqlDialect = 'postgresql' | 'mysql' | 'mariadb' | 'transactsql' | 'sqlite';
