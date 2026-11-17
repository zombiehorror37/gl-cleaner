import * as XLSX from 'xlsx';
import { serialToIso, type CellValue } from './values';

export interface RawSheet {
  name: string;
  /** Cell matrix, row-major, exactly as the file holds it (no rows dropped). */
  matrix: CellValue[][];
}

export interface RawWorkbook {
  fileName: string;
  sheets: RawSheet[];
  /** Text encoding used for CSV input (utf-8, or windows-1256 for Arabic ANSI CSVs). */
  encoding?: string;
}

const TEXT_EXT = /\.(csv|tsv|txt)$/i;

/**
 * Decode CSV bytes. Excel's "CSV (Comma delimited)" on an Arabic Windows
 * machine writes windows-1256, not UTF-8; try strict UTF-8 first.
 */
function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    try {
      return { text: new TextDecoder('windows-1256').decode(bytes), encoding: 'windows-1256' };
    } catch {
      return { text: new TextDecoder('latin1').decode(bytes), encoding: 'latin1' };
    }
  }
}

/**
 * Read a workbook into raw cell matrices.
 *
 * - CSV/TSV is read as plain text: SheetJS would otherwise guess dates and
 *   numbers itself (US month-first), silently swapping day and month.
 * - XLSX/XLS cells are read with their number format, so real Excel dates are
 *   recognised by format (not by guessing which numbers look like serials) and
 *   converted to calendar dates without any time-zone shift.
 */
export function readWorkbook(data: ArrayBuffer | Uint8Array, fileName: string): RawWorkbook {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  if (TEXT_EXT.test(fileName)) {
    const { text, encoding } = decodeText(bytes);
    const wb = XLSX.read(text.replace(/^﻿/, ''), { type: 'string', raw: true, dense: false });
    return {
      fileName,
      encoding,
      sheets: wb.SheetNames.map((name) => ({ name, matrix: sheetMatrix(wb.Sheets[name], true) })),
    };
  }

  const wb = XLSX.read(bytes, { type: 'array', cellDates: false, cellNF: true, cellText: true });
  return {
    fileName,
    sheets: wb.SheetNames.map((name) => ({ name, matrix: sheetMatrix(wb.Sheets[name], false) })),
  };
}

function sheetMatrix(ws: XLSX.WorkSheet, textOnly: boolean): CellValue[][] {
  const ref = ws['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const out: CellValue[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: CellValue[] = [];
    for (let c = 0; c <= range.e.c; c++) {
      if (c < range.s.c) {
        row.push(null);
        continue;
      }
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
      row.push(cell ? cellValue(cell, textOnly) : null);
    }
    // Trim trailing nulls so row length reflects real content.
    while (row.length && (row[row.length - 1] === null || row[row.length - 1] === '')) row.pop();
    out.push(row);
  }
  // Leading rows above the sheet's first used row.
  for (let r = 0; r < range.s.r; r++) out.unshift([]);
  return out;
}

function cellValue(cell: XLSX.CellObject, textOnly: boolean): CellValue {
  if (textOnly) {
    const v = cell.w ?? (cell.v === undefined || cell.v === null ? null : String(cell.v));
    return v === '' ? null : v;
  }
  switch (cell.t) {
    case 'n': {
      const v = cell.v as number;
      if (cell.z && typeof cell.z === 'string' && XLSX.SSF.is_date(cell.z)) {
        const iso = serialToIso(v);
        return iso ? { date: iso } : v;
      }
      return v;
    }
    case 'd': {
      const d = cell.v as Date;
      if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
      return { date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` };
    }
    case 's':
      return (cell.v as string) === '' ? null : (cell.v as string);
    case 'b':
      return cell.v as boolean;
    case 'e':
      // Error cells (#N/A, #REF!, #VALUE!) keep their text so validation can name them.
      return cell.w ?? '#ERROR';
    default:
      return null;
  }
}
