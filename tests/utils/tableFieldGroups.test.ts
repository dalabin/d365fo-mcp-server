/**
 * Regression: creating a table must always emit the 5 standard mandatory
 * D365FO field groups (AutoReport, AutoLookup, AutoIdentification, AutoSummary,
 * AutoBrowse). The VS D365FO project system requires them, and BP rules require
 * AutoReport to be non-empty and AutoIdentification to carry AutoPopulate=Yes.
 *
 * This guards the SmartXmlBuilder fallback path (Azure/Linux / bridge unavailable);
 * the C# bridge path emits the same 5 groups in MetadataWriteService.CreateSmartTable.
 */

import { describe, it, expect } from 'vitest';
import { SmartXmlBuilder } from '../../src/utils/smartXmlBuilder';

const MANDATORY_FIELD_GROUPS = [
  'AutoReport',
  'AutoLookup',
  'AutoIdentification',
  'AutoSummary',
  'AutoBrowse',
] as const;

/** Extract the inner XML of a named AxTableFieldGroup block. */
function fieldGroupBlock(xml: string, name: string): string {
  const marker = `<Name>${name}</Name>`;
  const idx = xml.indexOf(marker);
  if (idx === -1) return '';
  return xml.slice(idx).split('</AxTableFieldGroup>')[0];
}

describe('table create emits mandatory field groups', () => {
  const builder = new SmartXmlBuilder();
  const xml = builder.buildTableXml({
    name: 'VerifyTable',
    fields: [
      { name: 'AccountNum', edt: 'CustAccount', mandatory: true },
      { name: 'Name', edt: 'Name' },
      { name: 'Description', edt: 'Description' },
    ],
  });

  it.each(MANDATORY_FIELD_GROUPS)('emits the %s field group', (name) => {
    expect(xml).toContain(`<Name>${name}</Name>`);
  });

  it('emits exactly the 5 standard groups (no duplicates / omissions)', () => {
    const count = (xml.match(/<AxTableFieldGroup>/g) ?? []).length;
    expect(count).toBe(MANDATORY_FIELD_GROUPS.length);
  });

  it('AutoReport is populated — BP requires a non-empty group', () => {
    const block = fieldGroupBlock(xml, 'AutoReport');
    expect(block).toContain('<DataField>AccountNum</DataField>');
  });

  it('AutoIdentification carries AutoPopulate=Yes', () => {
    const block = fieldGroupBlock(xml, 'AutoIdentification');
    expect(block).toContain('<AutoPopulate>Yes</AutoPopulate>');
  });

  it('still emits all groups for a single-RecId table', () => {
    const recIdOnly = builder.buildTableXml({
      name: 'RecIdOnlyTable',
      fields: [{ name: 'RecId', edt: 'RecId', mandatory: true }],
    });
    for (const name of MANDATORY_FIELD_GROUPS) {
      expect(recIdOnly).toContain(`<Name>${name}</Name>`);
    }
  });
});
