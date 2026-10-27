export interface SqlParam {
  name: string;
  start: number;
  end: number;
}

/** Busca parámetros :nombre y ${variable} fuera de cadenas y comentarios. */
export function findParams(sql: string): SqlParam[] {
  const out: SqlParam[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') { const e = sql.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (ch === '/' && next === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      i++;
      while (i < n && !(sql[i] === ch && sql[i + 1] !== ch)) { if (sql[i] === ch) i++; i++; }
      i++;
      continue;
    }
    if (ch === '$' && next === '{') {
      const m = /^\$\{([A-Za-z_][\w.]*)\}/.exec(sql.slice(i, i + 80));
      if (m) { out.push({ name: m[1], start: i, end: i + m[0].length }); i += m[0].length; continue; }
    }
    if (ch === '$') {
      // dollar quoting de PostgreSQL
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64));
      if (m) { const e = sql.indexOf(m[0], i + m[0].length); i = e < 0 ? n : e + m[0].length; continue; }
    }
    if (ch === ':' && sql[i - 1] !== ':' && next !== ':' && next !== '=') {
      const m = /^:([A-Za-z_]\w*)/.exec(sql.slice(i, i + 80));
      if (m && !/[\w\]]/.test(sql[i - 1] ?? ' ')) { out.push({ name: m[1], start: i, end: i + m[0].length }); i += m[0].length; continue; }
    }
    i++;
  }
  return out;
}

export function substituteParams(sql: string, params: SqlParam[], values: Map<string, string>): string {
  let out = '';
  let last = 0;
  for (const p of params) {
    out += sql.slice(last, p.start) + (values.get(p.name) ?? sql.slice(p.start, p.end));
    last = p.end;
  }
  return out + sql.slice(last);
}
