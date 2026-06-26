/**
 * SmartXmlBuilder mined-defaults tests — generators take property defaults
 * from the property_stats majority values (standard Microsoft models) and
 * fall back to the static BP-validated defaults when no statistics exist.
 */

import { describe, it, expect } from 'vitest';
import { SmartXmlBuilder, MinedPropertyStats } from '../../src/utils/smartXmlBuilder';

const statsWith = (values: Record<string, string>): MinedPropertyStats => ({
  getPropertyValueDistribution(nodeType, property) {
    const value = values[`${nodeType}.${property}`];
    return value ? [{ value, count: 100 }] : [];
  },
});

const emptyStats: MinedPropertyStats = {
  getPropertyValueDistribution: () => [],
};

const throwingStats: MinedPropertyStats = {
  getPropertyValueDistribution: () => { throw new Error('db closed'); },
};

describe('buildTableXml TableGroup default', () => {
  const spec = { name: 'TestTable', fields: [{ name: 'Name', edt: 'Name' }] };

  it('uses the mined majority TableGroup when none is given', () => {
    const builder = new SmartXmlBuilder(statsWith({ 'AxTable.TableGroup': 'Transaction' }));
    expect(builder.buildTableXml(spec)).toContain('<TableGroup>Transaction</TableGroup>');
  });

  it('an explicit tableGroup always wins over mined stats', () => {
    const builder = new SmartXmlBuilder(statsWith({ 'AxTable.TableGroup': 'Transaction' }));
    expect(builder.buildTableXml({ ...spec, tableGroup: 'Parameter' }))
      .toContain('<TableGroup>Parameter</TableGroup>');
  });

  it('falls back to Main with empty stats', () => {
    const builder = new SmartXmlBuilder(emptyStats);
    expect(builder.buildTableXml(spec)).toContain('<TableGroup>Main</TableGroup>');
  });

  it('falls back to Main without a stats provider', () => {
    const builder = new SmartXmlBuilder();
    expect(builder.buildTableXml(spec)).toContain('<TableGroup>Main</TableGroup>');
  });

  it('survives a stats provider that throws', () => {
    const builder = new SmartXmlBuilder(throwingStats);
    expect(builder.buildTableXml(spec)).toContain('<TableGroup>Main</TableGroup>');
  });

  it('temp tables keep Main regardless of the mined majority', () => {
    const builder = new SmartXmlBuilder(statsWith({ 'AxTable.TableGroup': 'Transaction' }));
    const xml = builder.buildTableXml({ ...spec, tableType: 'TempDB' });
    expect(xml).toContain('<TableGroup>Main</TableGroup>');
    expect(xml).toContain('<TableType>TempDB</TableType>');
  });
});

describe('defaultFormPattern', () => {
  it('uses the mined majority AxFormDesign.Pattern, normalized to a supported template', () => {
    const builder = new SmartXmlBuilder(statsWith({ 'AxFormDesign.Pattern': 'Details Master' }));
    expect(builder.defaultFormPattern()).toBe('DetailsMaster');
  });

  it('unknown mined pattern names normalize to SimpleList', () => {
    const builder = new SmartXmlBuilder(statsWith({ 'AxFormDesign.Pattern': 'Custom' }));
    expect(builder.defaultFormPattern()).toBe('SimpleList');
  });

  it('falls back to SimpleList with no stats', () => {
    expect(new SmartXmlBuilder().defaultFormPattern()).toBe('SimpleList');
    expect(new SmartXmlBuilder(emptyStats).defaultFormPattern()).toBe('SimpleList');
  });
});

describe('buildPrimaryKeyIndex naming', () => {
  // ponytail: this is the index-name contract — Microsoft convention is `<FieldName>Idx`,
  // not `<TableName>Idx` and not `Idx_<FieldName>`. Tested so a rename of the table
  // (or a copy-paste of the function) doesn't silently break it.
  it('uses <FieldName>Idx for a single-field PK', () => {
    const builder = new SmartXmlBuilder();
    const ix = builder.buildPrimaryKeyIndex('MyTable', ['AccountNum']);
    expect(ix.name).toBe('AccountNumIdx');
    expect(ix.fields).toEqual(['AccountNum']);
    expect(ix.unique).toBe(true);
    expect(ix.clustered).toBe(false);
  });

  it('uses <Field1>_<Field2>Idx for composite PK', () => {
    const builder = new SmartXmlBuilder();
    const ix = builder.buildPrimaryKeyIndex('MyTable', ['AccountNum', 'DataAreaId']);
    expect(ix.name).toBe('AccountNum_DataAreaIdIdx');
  });

  it('ignores the tableName parameter (legacy contract kept for callers)', () => {
    // The 1st arg is unused now (was the source of `<TableName>Idx`). The signature
    // stays positional so callers don't have to update their arguments.
    const builder = new SmartXmlBuilder();
    expect(builder.buildPrimaryKeyIndex('AnythingAtAll', ['RuleId']).name).toBe('RuleIdIdx');
  });

  it('propagates the new name to <PrimaryIndex>/<ReplacementKey>/<ClusteredIndex>', () => {
    const builder = new SmartXmlBuilder();
    const xml = builder.buildTableXml({
      name: 'MyTable',
      label: 'My table',
      tableGroup: 'Main',
      fields: [
        { name: 'AccountNum', edt: 'CustAccount' },
        { name: 'Name', edt: 'Name' },
      ],
      indexes: [builder.buildPrimaryKeyIndex('MyTable', ['AccountNum'])],
    });
    expect(xml).toContain('<Name>AccountNumIdx</Name>');
    expect(xml).toContain('<PrimaryIndex>AccountNumIdx</PrimaryIndex>');
    expect(xml).toContain('<ReplacementKey>AccountNumIdx</ReplacementKey>');
    expect(xml).toContain('<ClusteredIndex>AccountNumIdx</ClusteredIndex>');
    // Old table-based name should NOT appear anywhere.
    expect(xml).not.toContain('MyTableIdx');
  });
});
