import * as fs from 'fs';
import * as vscode from 'vscode';
import { EXPORT_FORMATS, ExportContext, ExportFormat, formatData } from '../util/exporter';
import { CellValue } from '../util/values';

export function nonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

export function buildHtml(webview: vscode.Webview, extUri: vscode.Uri, opts: { title: string; scripts: string[]; styles?: string[]; body: string }): string {
  const n = nonce();
  const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', f)).toString();
  const styles = ['common.css', ...(opts.styles ?? [])].map(s => `<link rel="stylesheet" href="${uri(s)}">`).join('\n');
  const scripts = opts.scripts.map(s => `<script nonce="${n}" src="${uri(s)}"></script>`).join('\n');
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${opts.title}</title>
${styles}
</head>
<body>
${opts.body}
${scripts}
</body>
</html>`;
}

/** Acciones comunes de la grilla (copiar, abrir valor). Devuelve true si se manejó el mensaje. */
export async function handleGridMessage(msg: any, ctx: ExportContext): Promise<boolean> {
  switch (msg.type) {
    case 'copy': {
      const text = formatData(msg.format as ExportFormat, msg.columns, msg.rows, { ...ctx, header: msg.header });
      await vscode.env.clipboard.writeText(msg.format === 'tsv' ? text.replace(/\r\n$/, '') : text);
      vscode.window.setStatusBarMessage(`hBD: ${msg.rows.length} fila(s) copiadas`, 2500);
      return true;
    }
    case 'copyText':
      await vscode.env.clipboard.writeText(msg.text ?? '');
      vscode.window.setStatusBarMessage('hBD: valor copiado', 2000);
      return true;
    case 'openValue': {
      let content = msg.value === null || msg.value === undefined ? '' : String(msg.value);
      let language = 'plaintext';
      try {
        const parsed = JSON.parse(content);
        if (typeof parsed === 'object' && parsed !== null) { content = JSON.stringify(parsed, null, 2); language = 'json'; }
      } catch { /* no es JSON */ }
      if (language === 'plaintext' && /^\s*</.test(content)) language = 'xml';
      const doc = await vscode.workspace.openTextDocument({ content, language });
      await vscode.window.showTextDocument(doc, { preview: false });
      return true;
    }
    case 'openSql': {
      const doc = await vscode.workspace.openTextDocument({ content: msg.sql ?? '', language: 'sql' });
      await vscode.window.showTextDocument(doc, { preview: false });
      return true;
    }
  }
  return false;
}

/** Pide formato y archivo y guarda los datos exportados. */
export async function exportRowsToFile(columns: string[], rows: CellValue[][], baseName: string, ctx: ExportContext): Promise<void> {
  const fmt = await pickExportFormat();
  if (!fmt) return;
  const target = await askExportTarget(baseName, fmt.id);
  if (!target) return;
  const text = formatData(fmt.id, columns, rows, ctx);
  await fs.promises.writeFile(target.fsPath, fmt.id === 'csv' ? '﻿' + text : text, 'utf8');
  notifyExported(target, rows.length);
}

export async function pickExportFormat(): Promise<{ id: ExportFormat; label: string; ext: string } | undefined> {
  const pick = await vscode.window.showQuickPick(EXPORT_FORMATS.map(f => ({ label: f.label, description: '.' + f.ext, f })), { placeHolder: 'Formato de exportación' });
  return pick?.f;
}

export async function askExportTarget(baseName: string, fmt: ExportFormat): Promise<vscode.Uri | undefined> {
  const f = EXPORT_FORMATS.find(x => x.id === fmt)!;
  const safe = baseName.replace(/[\\/:*?"<>|]+/g, '_') || 'export';
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, `${safe}.${f.ext}`) : vscode.Uri.file(`${safe}.${f.ext}`),
    filters: { [f.label]: [f.ext] }
  });
}

export function notifyExported(target: vscode.Uri, count: number): void {
  vscode.window.showInformationMessage(`hBD: ${count} fila(s) exportadas a ${target.fsPath}`, 'Abrir').then(c => {
    if (c === 'Abrir') vscode.commands.executeCommand('vscode.open', target);
  });
}
