import { CellValue, cellToText } from './values';

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql' | 'xml' | 'html' | 'markdown' | 'txt';

export const EXPORT_FORMATS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: 'csv', label: 'CSV', ext: 'csv' },
  { id: 'tsv', label: 'TSV (tabulado)', ext: 'tsv' },
  { id: 'json', label: 'JSON', ext: 'json' },
  { id: 'sql', label: 'SQL INSERT', ext: 'sql' },
  { id: 'xml', label: 'XML', ext: 'xml' },
  { id: 'html', label: 'HTML', ext: 'html' },
  { id: 'markdown', label: 'Markdown', ext: 'md' },
  { id: 'txt', label: 'Texto alineado', ext: 'txt' }
];

export interface ExportContext {
  tableName?: string;
  quoteIdent?: (s: string) => string;
  literal?: (v: unknown) => string;
  csvDelimiter?: string;
  header?: boolean;
}

const csvCell = (v: CellValue, d: string) => {
  if (v === null) return '';
  const s = String(v);
  return s.includes(d) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function formatData(format: ExportFormat, columns: string[], rows: CellValue[][], ctx: ExportContext = {}): string {
  const header = ctx.header !== false;
  switch (format) {
    case 'csv':
    case 'tsv': {
      const d = format === 'tsv' ? '\t' : (ctx.csvDelimiter ?? ',');
      const lines = rows.map(r => r.map(v => format === 'tsv' ? cellToText(v).replace(/[\t\r\n]+/g, ' ') : csvCell(v, d)).join(d));
      if (header) lines.unshift(columns.map(c => format === 'tsv' ? c : csvCell(c, d)).join(d));
      return lines.join('\r\n') + '\r\n';
    }
    case 'json': {
      const objs = rows.map(r => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
      return JSON.stringify(objs, null, 2) + '\n';
    }
    case 'sql': {
      const q = ctx.quoteIdent ?? ((s: string) => `"${s.replace(/"/g, '""')}"`);
      const lit = ctx.literal ?? ((v: unknown) => v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
      const table = ctx.tableName ?? q('tabla');
      const cols = columns.map(q).join(', ');
      return rows.map(r => `INSERT INTO ${table} (${cols}) VALUES (${r.map(v => lit(v)).join(', ')});`).join('\n') + '\n';
    }
    case 'xml': {
      const tag = (s: string) => /^[A-Za-z_][\w.-]*$/.test(s) ? s : 'column';
      const body = rows.map(r => '  <row>\n' + columns.map((c, i) => {
        const t = tag(c);
        const attr = t === c ? '' : ` name="${xmlEsc(c)}"`;
        return r[i] === null ? `    <${t}${attr} null="true"/>` : `    <${t}${attr}>${xmlEsc(String(r[i]))}</${t}>`;
      }).join('\n') + '\n  </row>').join('\n');
      return `<?xml version="1.0" encoding="UTF-8"?>\n<rows>\n${body}\n</rows>\n`;
    }
    case 'html': {
      const th = columns.map(c => `<th>${xmlEsc(c)}</th>`).join('');
      const trs = rows.map(r => '<tr>' + r.map(v => `<td>${v === null ? '<i>NULL</i>' : xmlEsc(String(v))}</td>`).join('') + '</tr>').join('\n');
      return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${xmlEsc(ctx.tableName ?? 'Exportación')}</title>
<style>table{border-collapse:collapse;font-family:sans-serif;font-size:13px}td,th{border:1px solid #ccc;padding:3px 6px}th{background:#eee}</style></head>
<body><table><thead><tr>${th}</tr></thead><tbody>\n${trs}\n</tbody></table></body></html>\n`;
    }
    case 'markdown': {
      const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      const lines = [`| ${columns.map(esc).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`];
      for (const r of rows) lines.push(`| ${r.map(v => v === null ? 'NULL' : esc(String(v))).join(' | ')} |`);
      return lines.join('\n') + '\n';
    }
    case 'txt': {
      const cells = rows.map(r => r.map(v => v === null ? '[NULL]' : String(v).replace(/\r?\n/g, ' ')));
      const widths = columns.map((c, i) => Math.min(80, Math.max(c.length, ...cells.map(r => r[i].length))));
      const fmt = (r: string[]) => r.map((s, i) => s.slice(0, widths[i]).padEnd(widths[i])).join(' | ');
      return [fmt(columns), widths.map(w => '-'.repeat(w)).join('-+-'), ...cells.map(fmt)].join('\n') + '\n';
    }
  }
}
