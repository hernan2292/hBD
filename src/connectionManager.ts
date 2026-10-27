import * as vscode from 'vscode';
import { BaseDriver, createDriver } from './drivers';
import { openSshTunnel, SshTunnel } from './drivers/sshTunnel';
import { ConnectionConfig } from './drivers/types';

const STATE_KEY = 'hbd.connections';

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
    this.configs = ctx.globalState.get<ConnectionConfig[]>(STATE_KEY, []);
  }

  list(): ConnectionConfig[] {
    return [...this.configs].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ConnectionConfig | undefined {
    return this.configs.find(c => c.id === id);
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
    const idx = this.configs.findIndex(c => c.id === config.id);
    const wasConnected = this.drivers.has(config.id);
    if (idx >= 0) this.configs[idx] = config; else this.configs.push(config);
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
    this.configs = this.configs.filter(c => c.id !== id);
    await this.ctx.secrets.delete(`hbd.pwd.${id}`);
    await this.ctx.secrets.delete(`hbd.ssh.${id}`);
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
    let n = 0;
    for (const c of list) {
      if (!c || !c.name || !c.driver) continue;
      this.configs.push({ ...c, id: this.newId() });
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
    const config = this.get(id);
    if (!config) throw new Error('La conexión no existe.');
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
