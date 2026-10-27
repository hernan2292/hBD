import { SqlDialect } from '../drivers/types';

export interface SqlStatement {
  /** Texto de la sentencia sin el delimitador final */
  text: string;
  /** Offset de inicio (sin espacios iniciales) en el texto original */
  start: number;
  /** Offset final (incluye el delimitador si existe) */
  end: number;
}

export interface SplitOptions {
  blankLineDelimiter?: boolean;
}

const ROUTINE_RE = /^\s*(create|alter)\s+(or\s+replace\s+|or\s+alter\s+)?(definer\s*=\s*\S+\s+)?(procedure|proc|function|trigger|event|package)\b/i;

/** Quita comentarios y espacios iniciales. */
export function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.replace(/^\s+/, '');
    if (t.startsWith('--')) {
      const nl = t.indexOf('\n');
      s = nl < 0 ? '' : t.slice(nl + 1);
    } else if (t.startsWith('/*')) {
      const e = t.indexOf('*/');
      s = e < 0 ? '' : t.slice(e + 2);
    } else {
      return t;
    }
  }
}

export function firstKeyword(sql: string): string {
  const m = /^[a-z_]+/i.exec(stripLeadingComments(sql));
  return m ? m[0].toLowerCase() : '';
}

/**
 * Divide un script en sentencias respetando comillas, comentarios, dollar-quoting de PostgreSQL,
 * bloques BEGIN...END de rutinas/triggers, DELIMITER de MySQL y GO de SQL Server.
 */
export function splitSql(text: string, dialect: SqlDialect, opts: SplitOptions = {}): SqlStatement[] {
  const out: SqlStatement[] = [];
  const isMy = dialect === 'mysql' || dialect === 'mariadb';
  const isPg = dialect === 'postgresql';
  const isMs = dialect === 'transactsql';
  let delimiter = ';';
  let stmtStart = 0;
  let depth = 0;
  let i = 0;
  const n = text.length;

  const push = (endText: number, endAll: number) => {
    const raw = text.slice(stmtStart, endText);
    const lead = raw.length - raw.replace(/^\s+/, '').length;
    const body = raw.trim();
    if (body && stripLeadingComments(body)) {
      out.push({ text: body, start: stmtStart + lead, end: endAll });
    }
    stmtStart = endAll;
    depth = 0;
  };

  const atLineStart = (pos: number) => {
    let k = pos - 1;
    while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--;
    return k < 0 || text[k] === '\n';
  };

  const currentIsRoutine = () => ROUTINE_RE.test(stripLeadingComments(text.slice(stmtStart, i)));

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    // DELIMITER (MySQL)
    if (isMy && (ch === 'D' || ch === 'd') && atLineStart(i) && /^delimiter\s+\S/i.test(text.slice(i, i + 12))) {
      push(i, i);
      const eol = text.indexOf('\n', i);
      const line = text.slice(i, eol < 0 ? n : eol);
      delimiter = line.replace(/^delimiter\s+/i, '').trim();
      i = eol < 0 ? n : eol + 1;
      stmtStart = i;
      continue;
    }

    // GO (SQL Server)
    if (isMs && (ch === 'G' || ch === 'g') && atLineStart(i) && /^go[ \t]*(\r?\n|$)/i.test(text.slice(i, i + 5))) {
      push(i, i + 2);
      const eol = text.indexOf('\n', i);
      i = eol < 0 ? n : eol + 1;
      stmtStart = i;
      continue;
    }

    // Comentarios
    if ((ch === '-' && next === '-') || (isMy && ch === '#')) {
      const eol = text.indexOf('\n', i);
      i = eol < 0 ? n : eol;
      continue;
    }
    if (ch === '/' && next === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }

    // Cadenas e identificadores entrecomillados
    if (ch === "'" || ch === '"' || (isMy && ch === '`') || (isMs && ch === '[')) {
      const close = ch === '[' ? ']' : ch;
      i++;
      while (i < n) {
        if (isMy && text[i] === '\\' && close !== '`') { i += 2; continue; }
        if (text[i] === close) {
          if (text[i + 1] === close) { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      continue;
    }

    // Dollar quoting (PostgreSQL)
    if (isPg && ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const e = text.indexOf(tag, i + tag.length);
        i = e < 0 ? n : e + tag.length;
        continue;
      }
    }

    // Delimitador
    if (text.startsWith(delimiter, i)) {
      const routine = delimiter === ';' && (depth > 0 || (isMs && currentIsRoutine()));
      if (!routine) {
        push(i, i + delimiter.length);
        i += delimiter.length;
        continue;
      }
    }

    // Palabras clave de bloque
    if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 64));
      const word = m ? m[0].toUpperCase() : '';
      if ((word === 'BEGIN' || word === 'CASE' || word === 'END') && !isPg && currentIsRoutine()) {
        if (word === 'BEGIN' || word === 'CASE') {
          depth++;
        } else {
          const after = /^\s+([A-Za-z]+)/.exec(text.slice(i + 3, i + 20));
          const w2 = after ? after[1].toUpperCase() : '';
          if (!['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR'].includes(w2)) depth = Math.max(0, depth - 1);
        }
      }
      i += word.length || 1;
      continue;
    }

    // Línea en blanco como delimitador
    if (opts.blankLineDelimiter && ch === '\n' && depth === 0) {
      const m = /^\n[ \t]*\r?\n/.exec(text.slice(i, i + 64));
      if (m && !currentIsRoutine()) {
        push(i, i + 1);
        i += 1;
        continue;
      }
    }
    i++;
  }
  push(n, n);
  return out;
}

/** Devuelve la sentencia en la posición indicada del texto (o la más cercana). */
export function statementAt(stmts: SqlStatement[], offset: number): SqlStatement | undefined {
  if (!stmts.length) return undefined;
  let best: SqlStatement | undefined;
  for (const s of stmts) {
    if (s.start <= offset) best = s;
    if (offset >= s.start && offset <= s.end) return s;
  }
  return best ?? stmts[0];
}
