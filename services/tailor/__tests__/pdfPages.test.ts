import { describe, expect, it } from 'vitest';
import { pdfPageCount } from '../pdfPages.js';

describe('pdfPageCount', () => {
  it('reads the root page-tree count', () => {
    const pdf = `
      << /Type /Catalog /Pages 1 0 R >>
      << /Type /Pages /Count 1 /Kids [2 0 R] >>
      << /Type /Page /Parent 1 0 R >>
    `;
    expect(pdfPageCount(pdf)).toBe(1);
  });

  it('uses the largest Pages count when the tree is nested', () => {
    const pdf = `
      << /Count 2 /Kids [3 0 R 4 0 R] /Type /Pages >>
      << /Type /Pages /Count 1 /Kids [5 0 R] >>
    `;
    expect(pdfPageCount(pdf)).toBe(2);
  });

  it('does not treat a leaf /Type /Page as a tree', () => {
    const pdf = `<< /Type /Page /Count 9 >>`;
    expect(pdfPageCount(pdf)).toBeNull();
  });

  it('returns null when the page tree is missing', () => {
    expect(pdfPageCount('%PDF-1.4\nhello')).toBeNull();
    expect(pdfPageCount(Buffer.from('no dictionaries'))).toBeNull();
  });
});
