// Reading uploaded spreadsheets (.xlsx, .csv) into rows of text, and sending .xlsx exports.
import ExcelJS from 'exceljs';
import { HttpError } from './records.js';

const MAX_ROWS = 20_000;
const MAX_COLUMNS = 200;

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return String(value);
  if (value.richText) return value.richText.map((part) => part.text).join('');
  if ('result' in value) return cellText(value.result); // formula: use its cached result
  if ('text' in value) return cellText(value.text); // hyperlink
  return '';
}

/** RFC 4180 CSV → rows of strings. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLUMNS).map((v) => v.trim()));
}

/** [{ name, rows: string[][] }] for every sheet of an .xlsx file, or the single table of a .csv file. */
export async function readWorkbook(buffer, filename) {
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b; // .xlsx files are zip archives
  if (/\.csv$/i.test(filename) || (!isZip && !/\.xlsx?$/i.test(filename))) {
    return [{ name: filename.replace(/\.[^.]+$/, '') || 'Sheet1', rows: parseCsv(buffer.toString('utf8').replace(/^﻿/, '')) }];
  }
  if (!isZip) throw new HttpError(400, 'Old .xls files are not supported. Save the file as .xlsx or .csv and upload it again.');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new HttpError(400, 'That file could not be read as an Excel workbook.');
  }
  return workbook.worksheets.map((sheet) => {
    const rows = [];
    const width = Math.min(sheet.columnCount, MAX_COLUMNS);
    sheet.eachRow({ includeEmpty: false }, (row, number) => {
      if (number > MAX_ROWS) return;
      const values = [];
      for (let c = 1; c <= width; c++) values.push(cellText(row.getCell(c).value).trim());
      rows[number - 1] = values;
    });
    return { name: sheet.name, rows: Array.from(rows, (r) => r || []) };
  });
}

/** Sends an .xlsx with one sheet per { name, columns: [[key, header, width?]], rows: [{ key: value }] }. */
export async function sendWorkbook(res, filename, sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name.slice(0, 31));
    ws.columns = sheet.columns.map(([key, header, width]) => ({ key, header, width: width || Math.max(12, header.length + 4) }));
    ws.addRows(sheet.rows);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}-${new Date().toISOString().slice(0, 10)}.xlsx"`,
  });
  res.send(buffer);
}
