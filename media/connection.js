// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  let cfg = /** @type {any} */ ({});
  let ports = {};
  let passwordChanged = false;
  let busy = false;

  function setDriver(d, resetPort) {
    cfg.driver = d;
    document.querySelectorAll('#drivers button').forEach((b) => b.classList.toggle('sel', b.getAttribute('data-d') === d));
    const file = d === 'sqlite';
    $('netBox').classList.toggle('hidden', file);
    $('sshBox').classList.toggle('hidden', file);
    $('fileBox').classList.toggle('hidden', !file);
    document.querySelectorAll('.mssql-only').forEach((e) => e.classList.toggle('hidden', d !== 'mssql'));
    if (resetPort && ports[d]) $('port').value = ports[d];
  }

  function updateSsh() {
    const on = $('sshEnabled').checked;
    $('sshFields').classList.toggle('hidden', !on);
    const key = $('sshAuth').value === 'key';
    document.querySelectorAll('.ssh-key').forEach((e) => e.classList.toggle('hidden', !key));
    $('sshSecretLabel').textContent = key ? 'Passphrase' : 'Contraseña SSH';
  }

  function collect() {
    return {
      id: cfg.id,
      driver: cfg.driver,
      name: $('name').value,
      group: $('group').value,
      color: $('color').value,
      host: $('host').value,
      port: $('port').value,
      database: $('database').value,
      user: $('user').value,
      savePassword: $('savePassword').checked,
      ssl: $('ssl').checked,
      trustServerCertificate: $('trustServerCertificate').checked,
      filePath: $('filePath').value,
      readOnly: $('readOnly').checked,
      showSystemObjects: $('showSystemObjects').checked,
      ssh: {
        enabled: $('sshEnabled').checked,
        host: $('sshHost').value,
        port: $('sshPort').value,
        user: $('sshUser').value,
        authType: $('sshAuth').value,
        privateKeyPath: $('sshKey').value
      }
    };
  }

  function send(type) {
    if (busy) return;
    busy = type === 'test';
    if (type === 'test') showResult('Probando conexión…', null);
    vscode.postMessage({ type, config: collect(), password: $('password').value, passwordChanged, sshSecret: $('sshSecret').value });
  }

  function showResult(text, ok) {
    const r = $('result');
    r.textContent = text;
    r.className = 'result' + (ok === true ? ' ok' : ok === false ? ' err' : '');
  }

  document.querySelectorAll('#drivers button').forEach((b) => b.addEventListener('click', () => setDriver(b.getAttribute('data-d'), true)));
  $('password').addEventListener('input', () => { passwordChanged = true; });
  $('sshEnabled').addEventListener('change', updateSsh);
  $('sshAuth').addEventListener('change', updateSsh);
  $('browse').addEventListener('click', () => vscode.postMessage({ type: 'browse', target: 'file' }));
  $('browseNew').addEventListener('click', () => vscode.postMessage({ type: 'browse', target: 'file', save: true }));
  $('browseKey').addEventListener('click', () => vscode.postMessage({ type: 'browse', target: 'key' }));
  $('test').addEventListener('click', () => send('test'));
  $('save').addEventListener('click', () => send('save'));
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('host').addEventListener('input', () => {
    if (!$('name').value || $('name').dataset.auto === '1') { $('name').value = $('host').value; $('name').dataset.auto = '1'; }
  });
  $('name').addEventListener('input', () => { $('name').dataset.auto = '0'; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send('save'); });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'init') {
      cfg = m.config;
      ports = m.ports;
      $('formTitle').textContent = m.isNew ? 'Nueva conexión' : `Editar conexión: ${cfg.name}`;
      $('groups').innerHTML = m.groups.map((g) => `<option value="${String(g).replace(/"/g, '&quot;')}">`).join('');
      $('name').value = cfg.name || '';
      $('group').value = cfg.group || '';
      $('color').value = cfg.color || '';
      $('host').value = cfg.host || '';
      $('port').value = cfg.port || '';
      $('database').value = cfg.database || '';
      $('user').value = cfg.user || '';
      $('savePassword').checked = cfg.savePassword !== false;
      $('ssl').checked = !!cfg.ssl;
      $('trustServerCertificate').checked = cfg.trustServerCertificate !== false;
      $('filePath').value = cfg.filePath || '';
      $('readOnly').checked = !!cfg.readOnly;
      $('showSystemObjects').checked = !!cfg.showSystemObjects;
      const ssh = cfg.ssh || {};
      $('sshEnabled').checked = !!ssh.enabled;
      $('sshHost').value = ssh.host || '';
      $('sshPort').value = ssh.port || 22;
      $('sshUser').value = ssh.user || '';
      $('sshAuth').value = ssh.authType || 'password';
      $('sshKey').value = ssh.privateKeyPath || '';
      $('pwdHint').textContent = m.hasPassword ? '(guardada — déjela vacía para conservarla)' : '';
      $('name').dataset.auto = m.isNew ? '1' : '0';
      setDriver(cfg.driver || 'postgres', false);
      updateSsh();
      $('name').focus();
    } else if (m.type === 'file') {
      if (m.target === 'key') $('sshKey').value = m.path;
      else {
        $('filePath').value = m.path;
        if (!$('name').value || $('name').dataset.auto === '1') { $('name').value = m.path.split(/[\\/]/).pop(); $('name').dataset.auto = '1'; }
      }
    } else if (m.type === 'testResult') {
      busy = false;
      showResult(m.text, m.ok);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
