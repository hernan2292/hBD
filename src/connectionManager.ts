import * as fs from 'fs';
import * as vscode from 'vscode';
import { BaseDriver, createDriver } from './drivers';
import { openSshTunnel, SshTunnel } from './drivers/sshTunnel';
import { ConnectionConfig } from './drivers/types';

/** Lista de conexiones (se sincroniza entre equipos si hbd.syncConnections está activo). */
export const STATE_KEY = 'hbd.connections';
/** Rutas propias de este equipo (archivo SQLite, clave SSH); nunca se sincroniza. */
const LOCAL_KEY = 'hbd.localOverrides';

interface LocalOverride {
  filePath?: string;
  privateKeyPath?: string;
}

export function syncEnabled(): boolean {
  return vscode.workspace.getConfiguration('hbd').get<boolean>('syncConnections', true);
}

export class ConnectionManager implements vscode.Disposable {
  private configs: ConnectionConfig[];
  private drivers = new Map<string, BaseDriver>();
  private tunnels = new Map<string, SshTunnel>();
  private pending = new Map<string, Promise<BaseDriver>>();
  private sessionPasswords = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<string | undefined>();
  /** Se dispara cuando cambia la lista de conexiones o el estado de alguna (id o undefined para todas). */
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidChangeTx = new vscode.EventEmitter<string>();
  readonly onDidChangeTx = this._onDidChangeTx.event;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly log: vscode.OutputChannel) {
    this.configs = this.load();
  }

  private load(): ConnectionConfig[] {
    return this.ctx.globalState.get<ConnectionConfig[]>(STATE_KEY, []);
  }

  /**
   * Recarga la lista si cambió desde otro equipo (Sincronización de configuración).
   * Devuelve true si hubo cambios.
   */
  async reloadIfChanged(): Promise<boolean> {
    const fresh = this.load();
    if (JSON.stringify(fresh) === JSON.stringify(this.configs)) return false;
    const removed = this.configs.filter(c => !fresh.some(f => f.id === c.id));
    this.configs = fresh;
    for (const c of removed) {
      if (this.drivers.has(c.id)) await this.disconnect(c.id);
      await this.ctx.secrets.delete(`hbd.pwd.${c.id}`);
      await this.ctx.secrets.delete(`hbd.ssh.${c.id}`);
    }
    this.log.appendLine(`[${new Date().toLocaleTimeString()}] Conexiones actualizadas desde la sincronización`);
    this._onDidChange.fire(undefined);
    return true;
  }

  private overrides(): Record<string, LocalOverride> {
    return this.ctx.globalState.get<Record<string, LocalOverride>>(LOCAL_KEY, {});
  }

  private async setOverride(id: string, o: LocalOverride | undefined): Promise<void> {
    const all = { ...this.overrides() };
    if (o && (o.filePath !== undefined || o.privateKeyPath !== undefined)) all[id] = o; else delete all[id];
    await this.ctx.globalState.update(LOCAL_KEY, all);
  }

  /** Aplica las rutas locales de este equipo sobre la configuración sincronizada. */
  private effective(c: ConnectionConfig): ConnectionConfig {
    const o = this.overrides()[c.id];
    if (!o) return c;
    return {
      ...c,
      filePath: o.filePath ?? c.filePath,
      ssh: c.ssh ? { ...c.ssh, privateKeyPath: o.privateKeyPath ?? c.ssh.privateKeyPath } : c.ssh
    };
  }

  list(): ConnectionConfig[] {
    return this.configs.map(c => this.effective(c)).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ConnectionConfig | undefined {
    const c = this.configs.find(x => x.id === id);
    return c && this.effective(c);
  }

  newId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  private async persist(): Promise<void> {
    await this.ctx.globalState.update(STATE_KEY, this.configs);
    this._onDidChange.fire(undefined);
  }

  async hasStoredPassword(id: string): Promise<boolean> {
    return (await this.ctx.secrets.get(`hbd.pwd.${id}`)) !== undefined;
  }

  /**
   * Guarda una conexión. password / sshSecret: undefined = no cambiar, string = nuevo valor.
   */
  async save(config: ConnectionConfig, password?: string, sshSecret?: string): Promise<void> {
    await this.reloadIfChanged();
    const idx = this.configs.findIndex(c => c.id === config.id);
    const wasConnected = this.drivers.has(config.id);
    const stored = idx >= 0 ? this.configs[idx] : undefined;
    let toStore = config;
    if (stored && syncEnabled()) {
      // Las rutas que difieren de las sincronizadas se guardan solo para este equipo
      const o: LocalOverride = {};
      if (config.filePath !== stored.filePath) { o.filePath = config.filePath; toStore = { ...toStore, filePath: stored.filePath }; }
      const key = config.ssh?.privateKeyPath, storedKey = stored.ssh?.privateKeyPath;
      if (config.ssh && stored.ssh && key !== storedKey) {
        o.privateKeyPath = key;
        toStore = { ...toStore, ssh: { ...config.ssh, privateKeyPath: storedKey } };
      }
      await this.setOverride(config.id, o);
    } else {
      await this.setOverride(config.id, undefined);
    }
    if (idx >= 0) this.configs[idx] = toStore; else this.configs.push(toStore);
    if (password !== undefined) {
      if (config.savePassword) await this.ctx.secrets.store(`hbd.pwd.${config.id}`, password);
      else this.sessionPasswords.set(config.id, password);
    }
    if (!config.savePassword) await this.ctx.secrets.delete(`hbd.pwd.${config.id}`);
    if (sshSecret !== undefined) {
      if (config.savePassword) await this.ctx.secrets.store(`hbd.ssh.${config.id}`, sshSecret);
      else this.sessionPasswords.set(`ssh:${config.id}`, sshSecret);
    }
    if (wasConnected) await this.disconnect(config.id);
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id);
    await this.reloadIfChanged();
    this.configs = this.configs.filter(c => c.id !== id);
    await this.ctx.secrets.delete(`hbd.pwd.${id}`);
    await this.ctx.secrets.delete(`hbd.ssh.${id}`);
    await this.setOverride(id, undefined);
    await this.persist();
  }

  async duplicate(id: string): Promise<ConnectionConfig | undefined> {
    const c = this.get(id);
    if (!c) return undefined;
    const copy: ConnectionConfig = { ...JSON.parse(JSON.stringify(c)), id: this.newId(), name: c.name + ' (copia)' };
    const pwd = await this.ctx.secrets.get(`hbd.pwd.${id}`);
    const ssh = await this.ctx.secrets.get(`hbd.ssh.${id}`);
    await this.save(copy, pwd, ssh);
    return copy;
  }

  async importConfigs(list: ConnectionConfig[]): Promise<number> {
    return this.importItems(list.filter(c => c && c.name && c.driver).map(c => ({ config: c })));
  }

  /** ¿Ya existe una conexión importada desde este origen? */
  hasSource(sourceId: string): boolean {
    return this.configs.some(c => c.sourceId === sourceId);
  }

  /** Importa conexiones con sus credenciales opcionales (que van al almacenamiento seguro). */
  async importItems(items: { config: Omit<ConnectionConfig, 'id'> & { id?: string }; password?: string; sshSecret?: string }[]): Promise<number> {
    await this.reloadIfChanged();
    let n = 0;
    for (const it of items) {
      const id = this.newId() + n;
      const config: ConnectionConfig = { ...it.config, id };
      this.configs.push(config);
      if (it.password !== undefined) {
        if (config.savePassword) await this.ctx.secrets.store(`hbd.pwd.${id}`, it.password);
        else this.sessionPasswords.set(id, it.password);
      }
      if (it.sshSecret !== undefined) {
        if (config.savePassword) await this.ctx.secrets.store(`hbd.ssh.${id}`, it.sshSecret);
        else this.sessionPasswords.set(`ssh:${id}`, it.sshSecret);
      }
      n++;
    }
    await this.persist();
    return n;
  }

  isConnected(id: string): boolean {
    return this.drivers.get(id)?.isConnected() ?? false;
  }

  connectedDriver(id: string): BaseDriver | undefined {
    const d = this.drivers.get(id);
    return d?.isConnected() ? d : undefined;
  }

  connectedIds(): string[] {
    return [...this.drivers.keys()].filter(id => this.isConnected(id));
  }

  /**
   * Las rutas (archivo SQLite, clave SSH) pueden no existir en este equipo si la conexión
   * llegó por sincronización: se ofrece buscarlas y se guardan solo para este equipo.
   */
  private async checkLocalPaths(config: ConnectionConfig): Promise<ConnectionConfig> {
    const ask = async (what: string, file: string, create: boolean): Promise<string | undefined> => {
      const buttons = create ? ['Buscar archivo…', 'Crear base vacía'] : ['Buscar archivo…'];
      const choice = await vscode.window.showWarningMessage(
        `${what} de la conexión "${config.name}" no existe en este equipo:\n${file}`, { modal: true }, ...buttons);
      if (choice === 'Crear base vacía') return file;
      if (choice !== 'Buscar archivo…') throw new Error('Conexión cancelada.');
      const pick = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Usar este archivo' });
      if (!pick?.[0]) throw new Error('Conexión cancelada.');
      return pick[0].fsPath;
    };
    const o: LocalOverride = { ...this.overrides()[config.id] };
    let changed = false;
    if (config.driver === 'sqlite' && config.filePath && !fs.existsSync(config.filePath)) {
      const p = await ask('El archivo SQLite', config.filePath, true);
      if (p !== config.filePath) { o.filePath = p; changed = true; }
    }
    const key = config.ssh?.enabled && config.ssh.authType === 'key' ? config.ssh.privateKeyPath : undefined;
    if (key && config.driver !== 'sqlite' && !fs.existsSync(key)) {
      o.privateKeyPath = await ask('La clave privada SSH', key, false);
      changed = true;
    }
    if (!changed) return config;
    if (syncEnabled()) {
      await this.setOverride(config.id, o);
    } else {
      const idx = this.configs.findIndex(c => c.id === config.id);
      const c = this.configs[idx];
      this.configs[idx] = {
        ...c,
        filePath: o.filePath ?? c.filePath,
        ssh: c.ssh ? { ...c.ssh, privateKeyPath: o.privateKeyPath ?? c.ssh.privateKeyPath } : c.ssh
      };
      await this.persist();
    }
    return this.get(config.id)!;
  }

  /** Devuelve el driver de la conexión, conectando si hace falta. */
  async getDriver(id: string): Promise<BaseDriver> {
    const existing = this.drivers.get(id);
    if (existing?.isConnected()) return existing;
    if (existing) await this.disconnect(id);
    let p = this.pending.get(id);
    if (!p) {
      p = this.doConnect(id).finally(() => this.pending.delete(id));
      this.pending.set(id, p);
    }
    return p;
  }

  private async doConnect(id: string): Promise<BaseDriver> {
    let config = this.get(id);
    if (!config) throw new Error('La conexión no existe.');
    config = await this.checkLocalPaths(config);
    const password = await this.resolvePassword(config);
    const sshSecret = await this.resolveSshSecret(config);
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `hBD: conectando a ${config.name}...` },
      async () => {
        const { driver, tunnel } = await this.open(config, password, sshSecret);
        this.drivers.set(id, driver);
        if (tunnel) this.tunnels.set(id, tunnel);
        this.log.appendLine(`[${new Date().toLocaleTimeString()}] Conectado a ${config.name}`);
        this._onDidChange.fire(id);
        return driver;
      });
  }

  private async open(config: ConnectionConfig, password: string | undefined, sshSecret: string | undefined): Promise<{ driver: BaseDriver; tunnel?: SshTunnel }> {
    let effective = config;
    let tunnel: SshTunnel | undefined;
    if (config.ssh?.enabled && config.driver !== 'sqlite') {
      tunnel = await openSshTunnel(config.ssh, sshSecret, config.host || 'localhost', config.port || defaultPort(config));
      effective = { ...config, host: '127.0.0.1', port: tunnel.localPort };
    }
    const driver = createDriver(effective);
    try {
      await driver.connect(password);
    } catch (e) {
      tunnel?.close();
      throw e;
    }
    return { driver, tunnel };
  }

  /** Prueba una configuración sin guardarla. Devuelve la versión del servidor. */
  async test(config: ConnectionConfig, password: string | undefined, sshSecret: string | undefined): Promise<string> {
    if (password === undefined && config.savePassword) password = await this.ctx.secrets.get(`hbd.pwd.${config.id}`);
    if (sshSecret === undefined) sshSecret = await this.ctx.secrets.get(`hbd.ssh.${config.id}`);
    const { driver, tunnel } = await this.open(config, password ?? this.sessionPasswords.get(config.id), sshSecret);
    try {
      return await driver.version();
    } finally {
      await driver.disconnect();
      tunnel?.close();
    }
  }

  private async resolvePassword(config: ConnectionConfig): Promise<string | undefined> {
    if (config.driver === 'sqlite') return undefined;
    if (config.savePassword) {
      const s = await this.ctx.secrets.get(`hbd.pwd.${config.id}`);
      if (s !== undefined) return s;
    }
    const sess = this.sessionPasswords.get(config.id);
    if (sess !== undefined) return sess;
    const pwd = await vscode.window.showInputBox({
      prompt: `Contraseña para ${config.user ?? ''}@${config.name}`,
      password: true,
      ignoreFocusOut: true
    });
    if (pwd === undefined) throw new Error('Conexión cancelada.');
    if (config.savePassword) await this.ctx.secrets.store(`hbd.pwd.${config.id}`, pwd);
    else this.sessionPasswords.set(config.id, pwd);
    return pwd;
  }

  private async resolveSshSecret(config: ConnectionConfig): Promise<string | undefined> {
    if (!config.ssh?.enabled || config.driver === 'sqlite') return undefined;
    const stored = await this.ctx.secrets.get(`hbd.ssh.${config.id}`);
    if (stored !== undefined) return stored;
    const sess = this.sessionPasswords.get(`ssh:${config.id}`);
    if (sess !== undefined) return sess;
    if (config.ssh.authType === 'key') return undefined;
    const pwd = await vscode.window.showInputBox({
      prompt: `Contraseña SSH para ${config.ssh.user}@${config.ssh.host}`,
      password: true,
      ignoreFocusOut: true
    });
    if (pwd === undefined) throw new Error('Conexión cancelada.');
    this.sessionPasswords.set(`ssh:${config.id}`, pwd);
    return pwd;
  }

  async disconnect(id: string): Promise<void> {
    const d = this.drivers.get(id);
    this.drivers.delete(id);
    if (d) {
      if (d.hasOpenTransaction) {
        const choice = await vscode.window.showWarningMessage(
          `La conexión tiene una transacción abierta. ¿Qué desea hacer?`, { modal: true }, 'Commit', 'Rollback');
        try {
          if (choice === 'Commit') await d.commit(); else await d.rollback();
        } catch { /* ignorar */ }
      }
      await d.disconnect().catch(() => undefined);
      this.log.appendLine(`[${new Date().toLocaleTimeString()}] Desconectado de ${this.get(id)?.name ?? id}`);
    }
    this.tunnels.get(id)?.close();
    this.tunnels.delete(id);
    this._onDidChange.fire(id);
    this._onDidChangeTx.fire(id);
  }

  async disconnectAll(): Promise<void> {
    for (const id of [...this.drivers.keys()]) await this.disconnect(id);
  }

  fireTxChange(id: string): void {
    this._onDidChangeTx.fire(id);
  }

  dispose(): void {
    for (const d of this.drivers.values()) d.disconnect().catch(() => undefined);
    for (const t of this.tunnels.values()) t.close();
    this.drivers.clear();
    this.tunnels.clear();
    this._onDidChange.dispose();
    this._onDidChangeTx.dispose();
  }
}

function defaultPort(c: ConnectionConfig): number {
  return c.driver === 'postgres' ? 5432 : c.driver === 'mssql' ? 1433 : 3306;
}
