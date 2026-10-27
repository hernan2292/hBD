export type CellValue = string | number | boolean | null;

/** Convierte un valor devuelto por un driver en algo serializable para la grilla. */
export function normalizeValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toISOString().replace('T', ' ').replace('Z', '');
  if (v instanceof Uint8Array) {
    const b = Buffer.from(v);
    return b.length > 4096 ? `0x${b.subarray(0, 4096).toString('hex')}… (${b.length} bytes)` : '0x' + b.toString('hex');
  }
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

export function normalizeRows(rows: unknown[][]): CellValue[][] {
  return rows.map(r => r.map(normalizeValue));
}

export function cellToText(v: CellValue): string {
  return v === null ? '' : String(v);
}
