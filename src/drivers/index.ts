import { BaseDriver } from './base';
import { MsSqlDriver } from './mssql';
import { MySqlDriver } from './mysql';
import { PostgresDriver } from './postgres';
import { SqliteDriver } from './sqlite';
import { ConnectionConfig } from './types';

export function createDriver(config: ConnectionConfig): BaseDriver {
  switch (config.driver) {
    case 'postgres': return new PostgresDriver(config);
    case 'mysql':
    case 'mariadb': return new MySqlDriver(config);
    case 'mssql': return new MsSqlDriver(config);
    case 'sqlite': return new SqliteDriver(config);
    default: throw new Error(`Driver no soportado: ${(config as ConnectionConfig).driver}`);
  }
}

export { BaseDriver };
