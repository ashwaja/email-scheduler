export const maxRecipientFileBytes = 2 * 1024 * 1024;

export interface RecipientParseResult {
  accepted: string[];
  duplicateCount: number;
  invalidCount: number;
  rejectedRows: number;
  dataRows: number;
  headerDetected: boolean;
  errors: string[];
}

interface CsvResult {
  rows: string[][];
  malformed: boolean;
  unfinishedRow: boolean;
}

const emailHeaders = new Set([
  'email', 'e-mail', 'email address', 'e-mail address', 'recipient', 'recipient email', 'recipient address', 'address',
]);
const contactHeaders = new Set([
  ...emailHeaders, 'name', 'first name', 'last name', 'full name', 'company', 'phone', 'telephone', 'title',
]);

function parseCsv(text: string): CsvResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let malformed = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      if (field.length !== 0) malformed = true;
      else quoted = true;
    } else if (character === ',') {
      row.push(field.trim());
      field = '';
    } else if (character === '\n') {
      row.push(field.trim().replace(/\r$/, ''));
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  const unfinishedRow = quoted;
  if (unfinishedRow) malformed = true;
  if (!unfinishedRow) {
    row.push(field.trim().replace(/\r$/, ''));
    if (row.some((cell) => cell.length > 0)) rows.push(row);
  }
  return { rows, malformed, unfinishedRow };
}

function validEmail(value: string) {
  if (value.length > 254) return false;
  const separator = value.lastIndexOf('@');
  if (separator < 1 || separator > 64) return false;
  return /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,63}$/i.test(value);
}

function emptyResult(overrides: Partial<RecipientParseResult> = {}): RecipientParseResult {
  return {
    accepted: [],
    duplicateCount: 0,
    invalidCount: 0,
    rejectedRows: 0,
    dataRows: 0,
    headerDetected: false,
    errors: [],
    ...overrides,
  };
}

export function parseRecipientText(input: string): RecipientParseResult {
  const text = input.replace(/^\uFEFF/, '');
  if (!text.trim()) return emptyResult();

  const { rows, malformed, unfinishedRow } = parseCsv(text);
  if (malformed) {
    const firstRow = rows[0]?.map((cell) => cell.toLowerCase().replace(/\s+/g, ' ').trim()) ?? [];
    const hasHeader = firstRow.some((cell) => contactHeaders.has(cell));
    const rejectedRows = Math.max(1, rows.length + (unfinishedRow ? 1 : 0) - (hasHeader ? 1 : 0));
    return emptyResult({
      dataRows: rejectedRows,
      rejectedRows,
      headerDetected: hasHeader,
      errors: ['Malformed CSV quoting was found. No recipients were imported.'],
    });
  }
  if (!rows.length) return emptyResult();

  const normalizedHeader = rows[0]!.map((cell) => cell.toLowerCase().replace(/\s+/g, ' ').trim());
  const emailColumn = normalizedHeader.findIndex((cell) => emailHeaders.has(cell));
  const headerDetected = emailColumn >= 0 || normalizedHeader.some((cell) => contactHeaders.has(cell));
  const data = headerDetected ? rows.slice(1) : rows;
  const result = emptyResult({ headerDetected, dataRows: data.length });

  if (headerDetected && emailColumn < 0) {
    result.rejectedRows = data.filter((row) => row.some((cell) => cell.length > 0)).length;
    result.errors.push('The CSV header does not contain a recognized email column.');
    return result;
  }

  const seen = new Set<string>();
  for (const row of data) {
    if (!row.some((cell) => cell.length > 0)) {
      result.dataRows -= 1;
      continue;
    }
    const values = headerDetected
      ? [row[emailColumn]?.trim() ?? '']
      : row.flatMap((cell) => cell.split(/[;\s]+/).map((value) => value.trim()).filter(Boolean));
    let rowRejected = false;
    if (!values.length || values.every((value) => !value)) {
      result.rejectedRows += 1;
      continue;
    }
    for (const value of values) {
      if (!value) {
        rowRejected = true;
      } else if (!validEmail(value)) {
        result.invalidCount += 1;
        rowRejected = true;
      } else {
        const key = value.toLowerCase();
        if (seen.has(key)) result.duplicateCount += 1;
        else {
          seen.add(key);
          result.accepted.push(value);
        }
      }
    }
    if (rowRejected) result.rejectedRows += 1;
  }
  return result;
}
