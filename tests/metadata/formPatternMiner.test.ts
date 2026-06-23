/**
 * Form Pattern Miner / parseFormFile Tests
 *
 * Locks the Design-tree walker (src/metadata/formPatternMiner.ts) and the
 * fixed XppMetadataParser.parseFormFile form extraction:
 *   - datasources come from top-level <DataSources><AxFormDataSource>
 *   - design tree is walked through <Controls><AxFormControl i:type="...">
 *   - Pattern/PatternVersion are captured on Design AND container controls
 *   - methods come from SourceCode > Methods
 *
 * Uses FormPatternTemplates output as realistic fixtures so templates and
 * parser stay locked together, plus a hand-written DetailsMaster-style
 * fixture with nested sub-patterns.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Parser } from 'xml2js';
import { XppMetadataParser } from '../../src/metadata/xmlParser';
import { FormPatternTemplates } from '../../src/utils/formPatternTemplates';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import {
  crossCheckPatternCatalog,
  hasMinedPatternData,
} from '../../src/knowledge/formPatterns/crossCheck';
import {
  walkFormDesign,
  collectPatternNodes,
  normalizeControlType,
} from '../../src/metadata/formPatternMiner';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fpm-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFixture(name: string, xml: string): Promise<string> {
  const filePath = path.join(tmpDir, `${name}.xml`);
  await fs.writeFile(filePath, xml, 'utf-8');
  return filePath;
}

/** Parse a Design node the same way XppMetadataParser does */
async function parseDesign(xml: string): Promise<any> {
  const parser = new Parser({ explicitArray: false, mergeAttrs: true, trim: true });
  const parsed = await parser.parseStringPromise(xml);
  return parsed.AxForm.Design;
}

// ─── normalizeControlType ────────────────────────────────────────────────────

describe('normalizeControlType', () => {
  it('strips AxForm prefix and Control suffix', () => {
    expect(normalizeControlType('AxFormGridControl')).toBe('Grid');
    expect(normalizeControlType('AxFormActionPaneControl')).toBe('ActionPane');
    expect(normalizeControlType('AxFormTabPageControl')).toBe('TabPage');
    expect(normalizeControlType('AxFormStringControl')).toBe('String');
  });

  it('returns empty string for the bare base type and undefined', () => {
    expect(normalizeControlType('AxFormControl')).toBe('');
    expect(normalizeControlType(undefined)).toBe('');
  });

  it('preserves Control suffix for extension control types', () => {
    // QuickFilterControl is an extension control — its full name must be preserved
    // so it matches FormControlExtension.Name lookups in the validator.
    expect(normalizeControlType('AxFormQuickFilterControl')).toBe('QuickFilterControl');
    expect(normalizeControlType('AxFormSegmentedEntryControl')).toBe('SegmentedEntryControl');
  });
});

// ─── walkFormDesign on SimpleList template ───────────────────────────────────

describe('walkFormDesign (SimpleList template fixture)', () => {
  const xml = FormPatternTemplates.buildSimpleList({
    formName: 'FpmTestSimpleList',
    dsName: 'TestDS',
    dsTable: 'TestTable',
    caption: 'Test',
    gridFields: ['Field1', 'Field2'],
  });

  it('captures pattern and version from Design', async () => {
    const design = walkFormDesign(await parseDesign(xml));
    expect(design.pattern).toBe('SimpleList');
    expect(design.patternVersion).toBe('1.1');
    expect(design.style).toBe('SimpleList');
  });

  it('walks the full control tree in document order', async () => {
    const design = walkFormDesign(await parseDesign(xml));
    expect(design.controls.map((c) => c.type)).toEqual(['ActionPane', 'Group', 'Grid']);
    expect(design.controls.map((c) => c.name)).toEqual(['ActionPane', 'CustomFilterGroup', 'Grid']);

    const actionPane = design.controls[0];
    expect(actionPane.children.map((c) => c.type)).toEqual(['ButtonGroup']);
    expect(actionPane.axType).toBe('AxFormActionPaneControl');

    const grid = design.controls[2];
    expect(grid.children.map((c) => c.type)).toEqual(['String', 'String']);
    expect(grid.children[0].properties.DataField).toBe('Field1');
    expect(grid.children[0].properties.DataSource).toBe('TestDS');
  });

  it('captures sub-pattern on container controls', async () => {
    const design = walkFormDesign(await parseDesign(xml));
    const filterGroup = design.controls[1];
    expect(filterGroup.pattern).toBe('CustomAndQuickFilters');
    expect(filterGroup.patternVersion).toBe('1.1');
  });

  it('resolves extension controls via FormControlExtension name', async () => {
    const design = walkFormDesign(await parseDesign(xml));
    const quickFilter = design.controls[1].children[0];
    expect(quickFilter.name).toBe('QuickFilterControl');
    expect(quickFilter.type).toBe('QuickFilterControl');
  });

  it('collects pattern nodes for mining', async () => {
    const design = walkFormDesign(await parseDesign(xml));
    const records = collectPatternNodes(design);

    const designRecord = records.find((r) => r.nodePath === 'Design');
    expect(designRecord).toBeDefined();
    expect(designRecord!.pattern).toBe('SimpleList');
    expect(designRecord!.patternVersion).toBe('1.1');
    expect(designRecord!.childSequence).toEqual(['ActionPane', 'Group', 'Grid']);

    const subRecord = records.find((r) => r.controlName === 'CustomFilterGroup');
    expect(subRecord).toBeDefined();
    expect(subRecord!.nodePath).toBe('Design/Group[CustomFilterGroup]');
    expect(subRecord!.pattern).toBe('CustomAndQuickFilters');
    expect(subRecord!.controlType).toBe('Group');
  });
});

// ─── parseFormFile end-to-end ────────────────────────────────────────────────

describe('XppMetadataParser.parseFormFile', () => {
  const parser = new XppMetadataParser();

  it('extracts datasources from top-level <AxFormDataSource>', async () => {
    const xml = FormPatternTemplates.buildSimpleList({
      formName: 'FpmTestDs',
      dsName: 'CustGroup',
      dsTable: 'CustGroup',
      gridFields: ['CustGroup', 'Name'],
    });
    const filePath = await writeFixture('FpmTestDs', xml);
    const result = await parser.parseFormFile(filePath, 'TestModel');

    expect(result.success).toBe(true);
    expect(result.data.dataSources).toHaveLength(1);
    expect(result.data.dataSources[0].name).toBe('CustGroup');
    expect(result.data.dataSources[0].table).toBe('CustGroup');
    expect(result.data.dataSources[0].fields).toEqual(['CustGroup', 'Name']);
  });

  it('extracts design tree, pattern, and patternNodes', async () => {
    const xml = FormPatternTemplates.buildSimpleList({
      formName: 'FpmTestDesign',
      dsName: 'TestDS',
      dsTable: 'TestTable',
      gridFields: ['Field1'],
    });
    const filePath = await writeFixture('FpmTestDesign', xml);
    const result = await parser.parseFormFile(filePath, 'TestModel');

    expect(result.success).toBe(true);
    expect(result.data.formPattern).toBe('SimpleList');
    expect(result.data.formPatternVersion).toBe('1.1');
    expect(result.data.design.length).toBe(3);
    expect(result.data.patternNodes.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts form methods from SourceCode > Methods', async () => {
    const xml = FormPatternTemplates.buildSimpleList({
      formName: 'FpmTestMethods',
      dsName: 'TestDS',
      dsTable: 'TestTable',
    });
    const filePath = await writeFixture('FpmTestMethods', xml);
    const result = await parser.parseFormFile(filePath, 'TestModel');

    expect(result.success).toBe(true);
    expect(result.data.methods.map((m: any) => m.name)).toContain('classDeclaration');
  });

  it('handles DetailsMaster-style nesting with TabPage sub-patterns', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>FpmTestDetails</Name>
\t<SourceCode>
\t\t<Methods xmlns="">
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[
[Form]
public class FpmTestDetails extends FormRun
{
}
]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t\t<DataSources xmlns="" />
\t\t<DataControls xmlns="" />
\t\t<Members xmlns="" />
\t</SourceCode>
\t<DataSources>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>HeaderDS</Name>
\t\t\t<Table>HeaderTable</Table>
\t\t\t<Fields />
\t\t</AxFormDataSource>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>LinesDS</Name>
\t\t\t<Table>LinesTable</Table>
\t\t\t<Fields />
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design>
\t\t<Pattern xmlns="">DetailsMaster</Pattern>
\t\t<PatternVersion xmlns="">1.1</PatternVersion>
\t\t<Style xmlns="">DetailsFormMaster</Style>
\t\t<Controls xmlns="">
\t\t\t<AxFormControl xmlns="" i:type="AxFormActionPaneControl">
\t\t\t\t<Name>ActionPane</Name>
\t\t\t\t<Type>ActionPane</Type>
\t\t\t\t<Controls />
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns="" i:type="AxFormTabControl">
\t\t\t\t<Name>TabHeader</Name>
\t\t\t\t<Type>Tab</Type>
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormTabPageControl">
\t\t\t\t\t\t<Name>TabPageGeneral</Name>
\t\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t<Name>GroupIdentification</Name>
\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t<Controls />
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t</Controls>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
\t<Parts />
</AxForm>
`;
    const filePath = await writeFixture('FpmTestDetails', xml);
    const result = await parser.parseFormFile(filePath, 'TestModel');

    expect(result.success).toBe(true);
    expect(result.data.formPattern).toBe('DetailsMaster');
    expect(result.data.dataSources.map((ds: any) => ds.table)).toEqual([
      'HeaderTable',
      'LinesTable',
    ]);

    const tab = result.data.design.find((c: any) => c.type === 'Tab');
    expect(tab).toBeDefined();
    const tabPage = tab.children[0];
    expect(tabPage.type).toBe('TabPage');
    expect(tabPage.pattern).toBe('FieldsFieldGroups');

    const paths = result.data.patternNodes.map((r: any) => r.nodePath);
    expect(paths).toContain('Design');
    expect(paths).toContain('Design/Tab[TabHeader]/TabPage[TabPageGeneral]');
  });

  it('indexes patternNodes into form_patterns and records pattern stats', async () => {
    // End-to-end mining: parseFormFile → JSON → indexForms → SQLite
    const xml = FormPatternTemplates.buildSimpleList({
      formName: 'FpmIndexedForm',
      dsName: 'TestDS',
      dsTable: 'TestTable',
      gridFields: ['Field1'],
    });
    const filePath = await writeFixture('FpmIndexedForm', xml);
    const parsed = await parser.parseFormFile(filePath, 'TestModel');
    expect(parsed.success).toBe(true);

    const formsDir = path.join(tmpDir, 'forms');
    await fs.mkdir(formsDir, { recursive: true });
    await fs.writeFile(
      path.join(formsDir, 'FpmIndexedForm.json'),
      JSON.stringify(parsed.data, null, 2),
      'utf-8',
    );

    const index = new XppSymbolIndex(':memory:', ':memory:');
    try {
      (index as any).indexForms(formsDir, 'TestModel');
      index.flushPropertyStats();

      const db = index.getReadDb();
      expect(hasMinedPatternData(db)).toBe(true);

      const rows = db.prepare(
        `SELECT node_path, control_type, pattern, pattern_version, child_sequence
         FROM form_patterns WHERE form_name = 'FpmIndexedForm' ORDER BY node_path`,
      ).all() as any[];

      const design = rows.find((r) => r.node_path === 'Design');
      expect(design).toBeDefined();
      expect(design.pattern).toBe('SimpleList');
      expect(design.pattern_version).toBe('1.1');
      expect(JSON.parse(design.child_sequence)).toEqual(['ActionPane', 'Group', 'Grid']);

      const sub = rows.find((r) => r.node_path !== 'Design');
      expect(sub.pattern).toBe('CustomAndQuickFilters');
      expect(sub.control_type).toBe('Group');

      // Pattern distribution stats recorded for the Design node
      const stat = db.prepare(
        `SELECT count FROM property_stats
         WHERE node_type = 'AxFormDesign' AND property = 'Pattern' AND value = 'SimpleList'`,
      ).get() as any;
      expect(stat?.count).toBe(1);

      // Cross-check: SimpleList + CustomAndQuickFilters used; no gaps
      const report = crossCheckPatternCatalog(db);
      expect(report).not.toBeNull();
      expect(report!.minedFormCount).toBe(1);
      expect(report!.catalogGaps).toEqual([]);
      expect(report!.subPatternGaps).toEqual([]);
      expect(report!.unusedCatalogEntries).not.toContain('SimpleList');
      expect(report!.unusedCatalogEntries).toContain('Dialog'); // unused in this tiny index
    } finally {
      index.close?.();
    }
  });

  it('handles legacy forms with no pattern (falls back to Style, no patternNodes)', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>FpmTestLegacy</Name>
\t<SourceCode>
\t\t<Methods xmlns="" />
\t</SourceCode>
\t<DataSources />
\t<Design>
\t\t<Style xmlns="">Auto</Style>
\t\t<Controls xmlns="">
\t\t\t<AxFormControl xmlns="" i:type="AxFormGridControl">
\t\t\t\t<Name>MainGrid</Name>
\t\t\t\t<Type>Grid</Type>
\t\t\t\t<Controls />
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
</AxForm>
`;
    const filePath = await writeFixture('FpmTestLegacy', xml);
    const result = await parser.parseFormFile(filePath, 'TestModel');

    expect(result.success).toBe(true);
    expect(result.data.formPattern).toBe('Auto'); // Style fallback
    expect(result.data.formPatternVersion).toBeUndefined();
    expect(result.data.design.map((c: any) => c.type)).toEqual(['Grid']);
    expect(result.data.patternNodes).toEqual([]);
    expect(result.data.dataSources).toEqual([]);
  });
});
