/**
 * Per-pattern FormRun / datasource lifecycle method stubs.
 *
 * Stubs are correct-signature skeletons with super() calls and TODO markers —
 * injected by generate_smart when includeMethodStubs=true, and exposed
 * through get_form_pattern_spec as lifecycle guidance.
 */

import { resolvePattern } from './index.js';

export interface MethodStub {
  name: string;
  /** Complete X++ source, 4-space indented, ready for a CDATA block */
  source: string;
}

// ── Form-level stubs ─────────────────────────────────────────────────────────

const FORM_INIT: MethodStub = {
  name: 'init',
  source: `    public void init()
    {
        super();

        // TODO: read caller context, e.g.:
        // if (element.args() && element.args().record())
        // {
        //     ...
        // }
    }`,
};

const FORM_EXECUTE_QUERY = (dsName: string): MethodStub => ({
  name: 'executeQuery',
  source: `    public void executeQuery()
    {
        // TODO: add dynamic ranges before super(), e.g.:
        // SysQuery::findOrCreateRange(${dsName}_ds.queryBuildDataSource(), fieldNum(${dsName}, RecId));

        super();
    }`,
});

const FORM_CLOSE_OK: MethodStub = {
  name: 'closeOk',
  source: `    public void closeOk()
    {
        // TODO: apply the dialog action before the form closes.

        super();
    }`,
};

// ── Datasource-level stubs ───────────────────────────────────────────────────

const DS_INIT_VALUE: MethodStub = {
  name: 'initValue',
  source: `        public void initValue()
        {
            super();

            // TODO: default field values for new records.
        }`,
};

const DS_ACTIVE: MethodStub = {
  name: 'active',
  source: `        public int active()
        {
            int ret = super();

            // TODO: enable/disable controls based on the current record.

            return ret;
        }`,
};

const DS_VALIDATE_WRITE: MethodStub = {
  name: 'validateWrite',
  source: `        public boolean validateWrite()
        {
            boolean ret = super();

            // TODO: cross-field validation before save.

            return ret;
        }`,
};

/** Lines datasource initValue that defaults the foreign key from the header record. */
const LINES_INIT_VALUE = (headerDsName: string): MethodStub => ({
  name: 'initValue',
  source: `        public void initValue()
        {
            super();

            // TODO: default line fields from the header record, e.g.:
            // this.cursor().HeaderRecId = ${headerDsName || 'Header'}.RecId;
        }`,
});

// ── Per-pattern selection ────────────────────────────────────────────────────

export interface PatternMethodStubs {
  formMethods: MethodStub[];
  /** Stubs for the PRIMARY datasource */
  dataSourceMethods: MethodStub[];
  /** Stubs for the LINES datasource (header+lines patterns) */
  linesDataSourceMethods?: MethodStub[];
}

/**
 * Lifecycle stubs appropriate for a pattern. `dsName` is the primary
 * datasource name; `linesDsName` (optional) the lines datasource for
 * header+lines patterns (used to default line fields from the header).
 */
export function methodStubsForPattern(
  patternName: string,
  dsName: string,
  linesDsName?: string,
): PatternMethodStubs {
  const spec = resolvePattern(patternName);
  const id = spec?.id ?? 'SimpleList';

  switch (id) {
    case 'Dialog':
    case 'DropDialog':
      return {
        formMethods: [FORM_INIT, FORM_CLOSE_OK],
        dataSourceMethods: dsName ? [DS_INIT_VALUE] : [],
      };
    case 'Lookup':
      return {
        formMethods: [FORM_INIT, FORM_EXECUTE_QUERY(dsName)],
        dataSourceMethods: [],
      };
    case 'DetailsMaster':
    case 'DetailsMasterTabs':
      return {
        formMethods: [FORM_INIT],
        dataSourceMethods: [DS_ACTIVE, DS_VALIDATE_WRITE],
      };
    case 'DetailsTransaction':
      return {
        formMethods: [FORM_INIT],
        // Header datasource drives selection + save-time validation.
        dataSourceMethods: [DS_ACTIVE, DS_VALIDATE_WRITE],
        // Lines datasource defaults new-line fields from the header.
        linesDataSourceMethods: linesDsName
          ? [LINES_INIT_VALUE(dsName), DS_VALIDATE_WRITE]
          : undefined,
      };
    case 'SimpleListDetails':
      return {
        formMethods: [],
        dataSourceMethods: [DS_ACTIVE, DS_INIT_VALUE],
      };
    case 'Workspace':
    case 'WorkspaceOperational':
      return { formMethods: [FORM_INIT], dataSourceMethods: [] };
    case 'SimpleList':
    case 'ListPage':
    case 'TableOfContents':
    default:
      return {
        formMethods: [],
        dataSourceMethods: dsName ? [DS_INIT_VALUE, DS_VALIDATE_WRITE] : [],
      };
  }
}

// ── String-level injection into AxForm XML ───────────────────────────────────

function methodXml(stub: MethodStub, indent: string): string {
  return (
    `${indent}<Method>\n` +
    `${indent}\t<Name>${stub.name}</Name>\n` +
    `${indent}\t<Source><![CDATA[\n${stub.source}\n]]></Source>\n` +
    `${indent}</Method>\n`
  );
}

/**
 * Inject method stubs into AxForm XML (string-level, format-preserving):
 *  - form methods: appended after the classDeclaration </Method> inside
 *    SourceCode > Methods
 *  - datasource methods: inserted as a <Methods> block right after the
 *    primary AxFormDataSource's <Name> (merged when one already exists)
 *
 * Returns the new XML and the names of injected methods.
 */
export function injectMethodStubs(
  xml: string,
  stubs: PatternMethodStubs,
  dsName: string,
  linesDsName?: string,
): { xml: string; injected: string[] } {
  let result = xml;
  const injected: string[] = [];

  // Insert a <Methods> block right after a datasource's <Name>. Returns the
  // updated XML (or the original when the datasource/methods aren't found).
  const injectDsMethods = (src: string, targetDs: string, methods: MethodStub[]): string => {
    if (methods.length === 0 || !targetDs) return src;
    // Search from the real <DataSources> region so a same-named SourceCode method
    // can't be mistaken for the datasource's <Name>.
    const dsRegion = src.indexOf('<AxFormDataSource');
    const nameTag = `<Name>${targetDs}</Name>`;
    const nameIdx = src.indexOf(nameTag, dsRegion === -1 ? 0 : dsRegion);
    if (nameIdx === -1) return src;
    const insertAt = nameIdx + nameTag.length;
    const block =
      `\n\t\t\t<Methods>\n` +
      methods.map((s) => methodXml(s, '\t\t\t\t')).join('') +
      `\t\t\t</Methods>`;
    injected.push(...methods.map((s) => `${targetDs}.${s.name}`));
    return src.slice(0, insertAt) + block + src.slice(insertAt);
  };

  if (stubs.formMethods.length > 0) {
    // classDeclaration method block ends at the first </Method> after its <Name>
    const cdIdx = result.indexOf('<Name>classDeclaration</Name>');
    const closeIdx = cdIdx === -1 ? -1 : result.indexOf('</Method>', cdIdx);
    if (closeIdx !== -1) {
      const insertAt = closeIdx + '</Method>'.length;
      const block = stubs.formMethods
        .map((s) => `\n\t\t\t<Method>\n\t\t\t\t<Name>${s.name}</Name>\n\t\t\t\t<Source><![CDATA[\n${s.source}\n]]></Source>\n\t\t\t</Method>`)
        .join('');
      result = result.slice(0, insertAt) + block + result.slice(insertAt);
      injected.push(...stubs.formMethods.map((s) => s.name));
    }
  }

  result = injectDsMethods(result, dsName, stubs.dataSourceMethods);
  if (stubs.linesDataSourceMethods && linesDsName) {
    result = injectDsMethods(result, linesDsName, stubs.linesDataSourceMethods);
  }

  return { xml: result, injected };
}
