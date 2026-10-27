import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';
import { ConnectionConfig, DEFAULT_PORTS } from '../drivers/types';
import { errorText } from '../editor/sqlEditor';
import { buildHtml } from './webview';

/** Formulario (webview) para crear o editar una conexión. */
export class ConnectionForm {
  private static current: ConnectionForm | undefined;
  private readonly panel: vscode.WebviewPanel;

  static open(extUri: vscode.Uri, cm: ConnectionManager, existing?: ConnectionConfig): void {
    ConnectionForm.current?.panel.dispose();
    ConnectionForm.current = new ConnectionForm(extUri, cm, existing);
  }

  private constructor(extUri: vscode.Uri, private readonly cm: ConnectionManager, private readonly existing?: ConnectionConfig) {
    this.panel = vscode.window.createWebviewPanel('hbd.connection', existing ? `Editar: ${existing.name}` : 'Nueva conexión', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extUri, 'media')]
    });
    this.panel.iconPath = new vscode.ThemeIcon('database');
    this.panel.webview.html = buildHtml(this.panel.webview, extUri, {
      title: 'Conexión',
      scripts: ['connection.js'],
      styles: ['connection.css'],
      body: FORM_HTML
    });
    this.panel.onDidDispose(() => { if (ConnectionForm.current === this) ConnectionForm.current = undefined; });
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m));
  }

  private async onMessage(m: any): Promise<void> {
    switch (m.type) {
      case 'ready': {
        const groups = [...new Set(this.cm.list().map(c => c.group).filter(Boolean))];
        const hasPassword = this.existing ? await this.cm.hasStoredPassword(this.existing.id) : false;
        this.panel.webview.postMessage({
          type: 'init',
          config: this.existing ?? { id: this.cm.newId(), name: '', driver: 'postgres', host: 'localhost', port: 5432, savePassword: true },
          isNew: !this.existing,
          hasPassword,
          groups,
          ports: DEFAULT_PORTS
        });
        return;
      }
      case 'browse': {
        const isKey = m.target === 'key';
        const pick = m.save
          ? await vscode.window.showSaveDialog({ filters: { 'SQLite': ['db', 'sqlite', 'sqlite3', 'db3'] } })
          : (await vscode.window.showOpenDialog({ canSelectMany: false, filters: isKey ? undefined : { 'SQLite': ['db', 'sqlite', 'sqlite3', 'db3', '*'] } }))?.[0];
        if (pick) this.panel.webview.postMessage({ type: 'file', target: m.target, path: pick.fsPath });
        return;
      }
      case 'test': {
        const cfg = this.clean(m.config);
        try {
          const v = await this.cm.test(cfg, m.password === '' && !m.passwordChanged ? undefined : m.password, m.sshSecret || undefined);
          this.panel.webview.postMessage({ type: 'testResult', ok: true, text: `Conexión correcta.\n${v}` });
        } catch (e) {
          this.panel.webview.postMessage({ type: 'testResult', ok: false, text: errorText(e) });
        }
        return;
      }
      case 'save': {
        const cfg = this.clean(m.config);
        if (!cfg.name) { this.panel.webview.postMessage({ type: 'testResult', ok: false, text: 'El nombre es obligatorio.' }); return; }
        await this.cm.save(cfg, m.passwordChanged ? m.password : undefined, m.sshSecret ? m.sshSecret : undefined);
        vscode.window.setStatusBarMessage(`hBD: conexión "${cfg.name}" guardada`, 3000);
        this.panel.dispose();
        return;
      }
      case 'cancel':
        this.panel.dispose();
        return;
    }
  }

  private clean(c: any): ConnectionConfig {
    const cfg: ConnectionConfig = {
      id: String(c.id),
      name: String(c.name ?? '').trim(),
      driver: c.driver,
      group: c.group?.trim() || undefined,
      color: c.color || undefined,
      readOnly: !!c.readOnly,
      savePassword: !!c.savePassword,
      showSystemObjects: !!c.showSystemObjects
    };
    if (c.driver === 'sqlite') {
      cfg.filePath = String(c.filePath ?? '').trim();
    } else {
      cfg.host = String(c.host ?? '').trim() || 'localhost';
      cfg.port = Number(c.port) || DEFAULT_PORTS[c.driver as keyof typeof DEFAULT_PORTS];
      cfg.user = String(c.user ?? '').trim() || undefined;
      cfg.database = String(c.database ?? '').trim() || undefined;
      cfg.ssl = !!c.ssl;
      if (c.driver === 'mssql') cfg.trustServerCertificate = !!c.trustServerCertificate;
      if (c.ssh?.enabled) {
        cfg.ssh = {
          enabled: true,
          host: String(c.ssh.host ?? '').trim(),
          port: Number(c.ssh.port) || 22,
          user: String(c.ssh.user ?? '').trim(),
          authType: c.ssh.authType === 'key' ? 'key' : 'password',
          privateKeyPath: c.ssh.privateKeyPath || undefined
        };
      }
    }
    return cfg;
  }
}

const FORM_HTML = `
<div class="form">
  <h2 id="formTitle">Nueva conexión</h2>
  <div class="drivers" id="drivers">
    <button data-d="postgres">🐘 PostgreSQL</button>
    <button data-d="mysql">🐬 MySQL</button>
    <button data-d="mariadb">🦭 MariaDB</button>
    <button data-d="mssql">🪟 SQL Server</button>
    <button data-d="sqlite">🪶 SQLite</button>
  </div>

  <fieldset>
    <legend>General</legend>
    <div class="row"><label>Nombre</label><input id="name" placeholder="Mi base de datos"></div>
    <div class="row"><label>Carpeta</label><input id="group" list="groups" placeholder="(opcional) agrupa conexiones en el explorador"><datalist id="groups"></datalist></div>
    <div class="row"><label>Color</label>
      <select id="color">
        <option value="">(ninguno)</option>
        <option value="charts.red">Rojo (producción)</option>
        <option value="charts.orange">Naranja</option>
        <option value="charts.yellow">Amarillo</option>
        <option value="charts.green">Verde</option>
        <option value="charts.blue">Azul</option>
        <option value="charts.purple">Violeta</option>
      </select>
    </div>
  </fieldset>

  <fieldset id="netBox">
    <legend>Servidor</legend>
    <div class="row"><label>Host</label><input id="host" placeholder="localhost"><label class="short">Puerto</label><input id="port" type="number" class="port"></div>
    <div class="row"><label>Base de datos</label><input id="database" placeholder="(opcional)"></div>
    <div class="row"><label>Usuario</label><input id="user"></div>
    <div class="row"><label>Contraseña</label><input id="password" type="password" autocomplete="new-password"><span id="pwdHint" class="hint"></span></div>
    <div class="row"><label></label><label class="chk"><input id="savePassword" type="checkbox"> Guardar contraseña (almacenamiento seguro de VS Code)</label></div>
    <div class="row"><label></label><label class="chk"><input id="ssl" type="checkbox"> Usar SSL / cifrado</label></div>
    <div class="row mssql-only"><label></label><label class="chk"><input id="trustServerCertificate" type="checkbox"> Confiar en el certificado del servidor</label></div>
  </fieldset>

  <fieldset id="fileBox">
    <legend>Archivo SQLite</legend>
    <div class="row"><label>Archivo</label><input id="filePath" placeholder="C:\\ruta\\base.db"><button id="browse">Abrir…</button><button id="browseNew">Nuevo…</button></div>
    <div class="hint">Si el archivo no existe se crea una base vacía.</div>
  </fieldset>

  <fieldset id="sshBox">
    <legend><label class="chk"><input id="sshEnabled" type="checkbox"> Túnel SSH</label></legend>
    <div id="sshFields">
      <div class="row"><label>Host SSH</label><input id="sshHost"><label class="short">Puerto</label><input id="sshPort" type="number" class="port" value="22"></div>
      <div class="row"><label>Usuario SSH</label><input id="sshUser"></div>
      <div class="row"><label>Autenticación</label>
        <select id="sshAuth"><option value="password">Contraseña</option><option value="key">Clave privada</option></select>
      </div>
      <div class="row ssh-key"><label>Clave privada</label><input id="sshKey" placeholder="~/.ssh/id_rsa"><button id="browseKey">…</button></div>
      <div class="row"><label id="sshSecretLabel">Contraseña SSH</label><input id="sshSecret" type="password" autocomplete="new-password" placeholder="(se pedirá al conectar si se deja vacío)"></div>
    </div>
  </fieldset>

  <fieldset>
    <legend>Opciones</legend>
    <div class="row"><label></label><label class="chk"><input id="readOnly" type="checkbox"> Conexión de solo lectura (bloquea INSERT/UPDATE/DELETE/DDL)</label></div>
    <div class="row"><label></label><label class="chk"><input id="showSystemObjects" type="checkbox"> Mostrar bases/esquemas del sistema</label></div>
  </fieldset>

  <div id="result" class="result hidden"></div>
  <div class="actions">
    <button id="test">Probar conexión</button>
    <span style="flex:1"></span>
    <button id="cancel">Cancelar</button>
    <button id="save" class="primary">Guardar</button>
  </div>
</div>`;
