import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConnectionConfig, DriverType, SshConfig } from '../drivers/types';

export interface ImportedConnection {
  config: Omit<ConnectionConfig, 'id'>;
  password?: string;
  sshSecret?: string;
}

export interface ImportResult {
  items: ImportedConnection[];
  skipped: { name: string; reason: string }[];
}

/** Clave AES por defecto con la que DBeaver cifra credentials-config.json (documentada por DBeaver). */
const DBEAVER_KEY = Buffer.from('babb4a9f774ab853c96c2d653dfe544a', 'hex');

/** Descifra credentials-config.json de DBeaver (AES-128-CBC, IV = primeros 16 bytes). */
export function decryptDbeaverCredentials(buf: Buffer): Record<string, any> {
  if (buf.length < 32) throw new Error('Archivo de credenciales vacío o inválido.');
  const decipher = crypto.createDecipheriv('aes-128-cbc', DBEAVER_KEY, buf.subarray(0, 16));
  const text = Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString('utf8');
  return JSON.parse(text);
}

export function encryptDbeaverCredentials(data: unknown): Buffer {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', DBEAVER_KEY, iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
}

/** Carpetas habituales del workspace de DBeaver según el sistema operativo. */
function dbeaverWorkspaceRoots(): string[] {
  const home = os.homedir();
  const roots: string[] = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    roots.push(path.join(appData, 'DBeaverData', 'workspace6'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'DBeaverData', 'workspace6'));
  } else {
    roots.push(path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'DBeaverData', 'workspace6'));
  }
  roots.push(path.join(home, '.dbeaver4'), path.join(home, '.dbeaver'));
  return roots;
}

/** Busca archivos data-sources*.json de todos los proyectos de DBeaver. */
export function findDbeaverConfigs(): string[] {
  const out: string[] = [];
  for (const root of dbeaverWorkspaceRoots()) {
    if (!fs.existsSync(root)) continue;
    let projects: string[] = [];
    try { projects = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { continue; }
    for (const p of projects) {
      const dir = path.join(root, p, '.dbeaver');
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (/^data-sources.*\.json$/i.test(f)) out.push(path.join(dir, f));
      }
    }
  }
  return out;
}

export function isDbeaverConfig(data: unknown): boolean {
  return !!data && typeof data === 'object' && !Array.isArray(data) && typeof (data as any).connections === 'object';
}

function mapDriver(provider: string, driver: string, url: string): DriverType | undefined {
  const p = (provider || '').toLowerCase(), d = (driver || '').toLowerCase(), u = (url || '').toLowerCase();
  if (d.includes('mariadb') || u.startsWith('jdbc:mariadb:')) return 'mariadb';
  if (p === 'mysql' || d.startsWith('mysql') || u.startsWith('jdbc:mysql:')) return 'mysql';
  if (p === 'postgresql' || d.startsWith('postgres') || u.startsWith('jdbc:postgresql:')) return 'postgres';
  if (p === 'sqlserver' || p === 'mssql' || d === 'microsoft' || d.includes('jtds') || d.includes('mssql') || u.startsWith('jdbc:sqlserver:') || u.startsWith('jdbc:jtds:')) return 'mssql';
  if (d.includes('sqlite') || u.startsWith('jdbc:sqlite:')) return 'sqlite';
  return undefined;
}

/** Extrae host/puerto/base de una URL JDBC cuando faltan en la configuración. */
function parseJdbcUrl(url: string): { host?: string; port?: number; database?: string; file?: string } {
  if (!url) return {};
  const lite = /^jdbc:sqlite:(.+)$/i.exec(url);
  if (lite) return { file: lite[1] };
  const ms = /^jdbc:(?:sqlserver|jtds:sqlserver):\/\/([^;:/]*)(?::(\d+))?[^;]*;?(.*)$/i.exec(url);
  if (ms) {
    const props = Object.fromEntries(ms[3].split(';').filter(Boolean).map(kv => kv.split('=') as [string, string]).map(([k, v]) => [k.toLowerCase(), v]));
    return { host: ms[1] || props['servername'], port: ms[2] ? Number(ms[2]) : props['portnumber'] ? Number(props['portnumber']) : undefined, database: props['databasename'] || props['database'] };
  }
  const std = /^jdbc:[a-z0-9]+:\/\/([^:/?]+)(?::(\d+))?(?:\/([^?;]*))?/i.exec(url);
  if (std) return { host: std[1], port: std[2] ? Number(std[2]) : undefined, database: std[3] || undefined };
  return {};
}

const COLORS: Record<string, string> = { prod: 'charts.red', test: 'charts.orange' };

/** Convierte un data-sources.json de DBeaver (y opcionalmente sus credenciales) en conexiones de hBD. */
export function parseDbeaver(data: any, creds?: Record<string, any>): ImportResult {
  const res: ImportResult = { items: [], skipped: [] };
  const conns = data?.connections ?? {};
  for (const [dbId, c] of Object.entries<any>(conns)) {
    const name = String(c?.name ?? dbId).trim() || dbId;
    const cfg = c?.configuration ?? {};
    const driver = mapDriver(c?.provider, c?.driver, cfg.url);
    if (!driver) {
      res.skipped.push({ name, reason: `motor no soportado (${c?.provider ?? '?'} / ${c?.driver ?? '?'})` });
      continue;
    }
    const fromUrl = parseJdbcUrl(cfg.url ?? '');
    const cred = creds?.[dbId] ?? {};
    const connCred = cred['#connection'] ?? {};
    const pp = cfg['provider-properties'] ?? {};
    const config: Omit<ConnectionConfig, 'id'> = {
      name,
      driver,
      group: c?.folder ? String(c.folder) : undefined,
      color: COLORS[String(cfg.type ?? '').toLowerCase()],
      readOnly: c?.['read-only'] === true || undefined,
      savePassword: c?.['save-password'] !== false,
      sourceId: `dbeaver:${dbId}`
    };
    if (driver === 'sqlite') {
      config.filePath = cfg.database || fromUrl.file;
      if (!config.filePath) { res.skipped.push({ name, reason: 'SQLite sin ruta de archivo' }); continue; }
    } else {
      config.host = cfg.host || fromUrl.host || 'localhost';
      const port = Number(cfg.port) || fromUrl.port;
      if (port) config.port = port;
      config.database = cfg.database || fromUrl.database || undefined;
      config.user = connCred.user || cfg.user || undefined;
      const props = cfg.properties ?? {};
      if (String(props.ssl ?? props.useSSL ?? props.encrypt ?? '').toLowerCase() === 'true' || ['require', 'verify-ca', 'verify-full'].includes(String(props.sslmode ?? '').toLowerCase())) config.ssl = true;
      if (driver === 'mssql') {
        const trust = String(pp.sslTrustServerCertificate ?? props.trustServerCertificate ?? 'true').toLowerCase() !== 'false';
        config.trustServerCertificate = !config.ssl || trust;
      }
      const ssh = parseSsh(cfg.handlers ?? c?.handlers, cred);
      if (ssh) config.ssh = ssh.config;
      res.items.push({ config, password: connCred.password, sshSecret: ssh?.secret });
      continue;
    }
    res.items.push({ config });
  }
  return res;
}

function parseSsh(handlers: any, cred: any): { config: SshConfig; secret?: string } | undefined {
  if (!handlers || typeof handlers !== 'object') return undefined;
  const h = handlers['ssh_tunnel'] ?? Object.values<any>(handlers).find(x => /ssh/i.test(x?.type ?? '') || x?.properties?.host);
  if (!h || h.enabled === false) return undefined;
  const p = h.properties ?? {};
  const sc = cred['network/ssh_tunnel'] ?? {};
  const isKey = /key/i.test(String(p.authType ?? ''));
  return {
    config: {
      enabled: true,
      host: String(p.host ?? ''),
      port: Number(p.port) || 22,
      user: String(sc.user ?? h.user ?? p.user ?? ''),
      authType: isKey ? 'key' : 'password',
      privateKeyPath: isKey ? (p.keyPath ?? p.key ?? undefined) : undefined
    },
    secret: sc.password
  };
}
