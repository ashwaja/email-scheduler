import { describe, expect, it } from 'vitest';
import { maxRecipientFileBytes, parseRecipientText } from './recipient-parser';

describe('recipient text and CSV parsing', () => {
  it('accepts valid text emails and reports duplicates and invalid rows', () => {
    const result = parseRecipientText([
      'jane@example.com',
      'JANE@example.com',
      'not-an-email',
      'second@example.org',
    ].join('\n'));

    expect(result.accepted).toEqual(['jane@example.com', 'second@example.org']);
    expect(result.duplicateCount).toBe(1);
    expect(result.invalidCount).toBe(1);
    expect(result.rejectedRows).toBe(1);
  });

  it('uses the email column in a CSV header and handles quoted commas and line breaks', () => {
    const result = parseRecipientText('Name,Email,Company\n"Jane, Q.",jane@example.com,"Example, Inc."\n"Jane\nDoe",doe@example.org,Example');

    expect(result.headerDetected).toBe(true);
    expect(result.accepted).toEqual(['jane@example.com', 'doe@example.org']);
    expect(result.invalidCount).toBe(0);
  });

  it('rejects a malformed CSV without importing partial rows', () => {
    const result = parseRecipientText('email,name\nok@example.com,Jane\n"unterminated@example.com,Joe');

    expect(result.accepted).toEqual([]);
    expect(result.rejectedRows).toBe(2);
    expect(result.errors[0]).toMatch(/Malformed CSV/);
  });

  it('reports data rows as rejected when a recognized header has no email column', () => {
    const result = parseRecipientText('Name,Company\nJane,Example Inc.\nSam,Another Co.');

    expect(result.headerDetected).toBe(true);
    expect(result.accepted).toEqual([]);
    expect(result.rejectedRows).toBe(2);
    expect(result.errors[0]).toMatch(/email column/);
  });

  it('exposes a reasonable upload size limit', () => {
    expect(maxRecipientFileBytes).toBe(2 * 1024 * 1024);
  });
});
