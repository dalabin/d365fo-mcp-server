/**
 * Find References Tool
 * Find all usages of a symbol (method, class, field, table)
 * Critical for understanding impact before making changes
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { buildObjectTypeMismatchMessage, detectObjectTypeInDb } from '../utils/metadataResolver.js';
import { tryBridgeReferences } from '../bridge/bridgeAdapter.js';

const FindReferencesArgsSchema = z.object({
  // Accept "name" as an alias for "targetName" — agents frequently confuse the two.
  targetName: z.string().optional().describe('Name of the target. For a precise, type-scoped method where-used, qualify it as "Owner.method" (e.g. "SalesTable.initFromSalesQuotationTable") or pass an AOT path ("/Tables/SalesTable/Methods/initFromSalesQuotationTable"). A bare method name matches that name on every type.'),
  name: z.string().optional().describe('Alias for targetName.'),
  targetType: z.enum(['method', 'class', 'table', 'field', 'enum', 'all']).optional().describe('Type of the target to search for'),
  ownerName: z.string().optional().describe('Declaring table/class/form that owns the method, when targetName is just the bare method name. Used to scope the where-used to a single type (matches Visual Studio xref).'),
  scope: z.enum(['all', 'workspace', 'standard', 'custom']).optional().default('all').describe('Search scope'),
  limit: z.number().optional().default(50).describe('Maximum results to return'),
  // Default OFF: code-context snippets roughly quadruple the token cost of this tool.
  // Agents typically only need file:line:type — turn context on explicitly when you need snippets.
  includeContext: z.boolean().optional().default(false).describe('Include code context around reference (opt-in to reduce token usage)'),
}).refine(a => a.targetName || a.name, { message: "must have required property 'targetName'" });

/**
 * Map a symbol-index `type` value to its DYNAMICSXREFDB container segment.
 * Only types that can own methods/fields are listed — these are the containers
 * the xref path "/<Container>/<Owner>/<Methods|Fields>/<member>" is built from.
 * Enums are intentionally absent: their values are not methods or fields here.
 */
const TYPE_TO_XREF_CONTAINER: Record<string, string> = {
  table: 'Tables',
  class: 'Classes',
  form: 'Forms',
  query: 'Queries',
  view: 'Views',
  map: 'Maps',
  'data-entity': 'DataEntityViews',
};

/**
 * Resolve which xref containers an owner name exists as (Tables/Classes/…).
 * Usually one; returns several only when a name collides across object types.
 */
function resolveXrefContainers(db: any, ownerName: string): string[] {
  const types = detectObjectTypeInDb(db, ownerName);
  const containers = new Set<string>();
  for (const { type } of types) {
    const container = TYPE_TO_XREF_CONTAINER[type];
    if (container) containers.add(container);
  }
  return [...containers];
}

/**
 * Authoritative "no references" result for a member-scoped lookup when the xref
 * bridge is available and cleanly returned nothing. We deliberately do NOT fall
 * back to the name-only FTS scan here — that scan pools callers of every
 * same-named member across all types, which is exactly the wrong answer for
 * where-used. (Reached only on a clean empty, never on a bridge error.)
 */
function buildScopedEmptyResult(displayName: string, bridgeTargets: string[]): { content: Array<{ type: 'text'; text: string }> } {
  let out = `# References to \`${displayName}\`\n\n`;
  out += `**Total References Found:** 0\n`;
  out += `_Source: C# bridge (DYNAMICSXREFDB) — scoped to the declaring type_\n\n`;
  out += `No callers found for this specific member.\n\n`;
  out += `Resolved xref path(s):\n`;
  for (const t of bridgeTargets) out += `- \`${t}\`\n`;
  out += `\n**If you expected results:** verify the owner type and method name, `;
  out += `or pass an explicit AOT path as \`targetName\` (e.g. \`/Classes/MyClass/Methods/myMethod\`).\n`;
  return { content: [{ type: 'text', text: out }] };
}

interface Reference {
  file: string;
  model: string;
  line?: number;
  context: string;
  referenceType: 'call' | 'extends' | 'implements' | 'field-access' | 'instantiation' | 'type-reference';
  caller?: string;
}

export async function findReferencesTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = FindReferencesArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const { targetType, scope, limit, includeContext, ownerName } = args;
    const targetName = (args.targetName ?? args.name)!; // accept "name" alias

    // --- Parse the target shape ----------------------------------------------
    // Accept three forms:
    //   1. AOT path        "/Tables/SalesTable/Methods/initFromSalesQuotationTable"
    //   2. Owner-qualified "SalesTable.initFromSalesQuotationTable" (or ownerName + bare method)
    //   3. Bare name       "initFromSalesQuotationTable" / "CustTable"
    const cleanTargetName = targetName.replace(/\(.*$/, '').trim(); // strip trailing parens
    const isAotPath = cleanTargetName.startsWith('/');

    let owner: string | null = ownerName?.trim() || null;
    let memberName = cleanTargetName;
    if (!isAotPath && cleanTargetName.includes('.')) {
      const dot = cleanTargetName.lastIndexOf('.');
      owner = owner ?? (cleanTargetName.slice(0, dot).trim() || null);
      memberName = cleanTargetName.slice(dot + 1).trim();
    }

    // parentObjectName powers the cross-type ("you used a form name as a class") hint
    const parentObjectName: string | null =
      owner ?? ((targetType === 'class' || targetType === 'method') ? memberName : null);

    const wantsMethod = !targetType || targetType === 'method' || targetType === 'all';
    // Which AOT child segments to scope an "Owner.member" target to. A method
    // lookup hits "/Methods/", a field lookup "/Fields/"; the default ("all" /
    // unset) covers both, since we don't know whether the member is a method or
    // field. Building only "/Methods/" (the original bug) made a field-qualified
    // target return an authoritative — and wrong — "no callers".
    const memberSegments: string[] = [];
    if (wantsMethod) memberSegments.push('Methods');
    if (!targetType || targetType === 'field' || targetType === 'all') memberSegments.push('Fields');

    // --- Build the bridge target(s) ------------------------------------------
    // The DYNAMICSXREFDB bridge scopes a member to its declaring type ONLY when
    // given a member-qualified path. A bare member name matches no object there
    // and silently returns 0 — so when an owner is known we resolve its container
    // type and build "/<Container>/<Owner>/<Methods|Fields>/<member>" before querying.
    let bridgeTargets: string[] = [cleanTargetName];
    let memberScoped = false;
    if (isAotPath) {
      memberScoped = cleanTargetName.includes('/Methods/') || cleanTargetName.includes('/Fields/');
    } else if (owner && memberSegments.length > 0) {
      const containers = resolveXrefContainers(symbolIndex.getReadDb(), owner);
      bridgeTargets = containers.length > 0
        ? containers.flatMap(c => memberSegments.map(seg => `/${c}/${owner}/${seg}/${memberName}`))
        // Owner not indexed — hand the qualified name to the bridge, which (when
        // built with member-variant expansion) resolves it across container types.
        : [`${owner}.${memberName}`];
      memberScoped = true;
    }

    // Try C# bridge first (DYNAMICSXREFDB — live cross-references)
    const bridgeOutcome = await tryBridgeReferences(context.bridge, bridgeTargets, limit, targetName);
    if (bridgeOutcome.status === 'ok') return bridgeOutcome.result;

    // For a member-scoped lookup the xref bridge is authoritative — but ONLY when
    // it cleanly returned no rows ('empty'). On 'error' (RPC/SQL failure) or
    // 'unavailable' we deliberately fall through to the FTS heuristic rather than
    // report a confident "0 references" we can't actually stand behind. Reporting
    // the empty scoped result here is what avoids the name-only FTS scan pooling
    // callers of every same-named member across all types (the "25 references" bug).
    if (memberScoped && bridgeOutcome.status === 'empty') {
      return buildScopedEmptyResult(targetName, bridgeTargets);
    }

    // Build search patterns (FTS fallback — only reached when the xref bridge is
    // unavailable). This is a name-based heuristic and cannot scope a method to
    // its declaring type; match on the bare member name.
    const ftsName = isAotPath
      ? (cleanTargetName.split('/').pop() || cleanTargetName)
      : memberName;
    const references: Reference[] = [];
    let totalReferences = 0;

    // 1. Search for method calls
    if (!targetType || targetType === 'method' || targetType === 'all') {
      const methodRefs = findMethodReferences(symbolIndex, ftsName, scope, limit);
      references.push(...methodRefs);
    }

    // 2. Search for class references (extends, implements, instantiations)
    if (!targetType || targetType === 'class' || targetType === 'all') {
      const classRefs = findClassReferences(symbolIndex, ftsName, scope, limit);
      references.push(...classRefs);
    }

    // 3. Search for table references (select statements, table buffers)
    if (!targetType || targetType === 'table' || targetType === 'all') {
      const tableRefs = findTableReferences(symbolIndex, ftsName, scope, limit);
      references.push(...tableRefs);
    }

    // 4. Search for field references
    if (!targetType || targetType === 'field' || targetType === 'all') {
      const fieldRefs = findFieldReferences(symbolIndex, ftsName, scope, limit);
      references.push(...fieldRefs);
    }

    // 5. Search for enum references
    if (!targetType || targetType === 'enum' || targetType === 'all') {
      const enumRefs = findEnumReferences(symbolIndex, ftsName, scope, limit);
      references.push(...enumRefs);
    }

    // Limit results
    totalReferences = references.length;
    const limitedReferences = references.slice(0, limit);

    // Generate summary
    const summary = generateReferenceSummary(limitedReferences);

    // Format output
    let output = `# References to \`${targetName}\`\n\n`;
    output += `**Total References Found:** ${totalReferences}\n`;
    output += `**Showing:** ${limitedReferences.length} results\n`;
    if (targetType) {
      output += `**Target Type:** ${targetType}\n`;
    }
    output += `**Scope:** ${scope}\n`;
    output += `_Source: name-based index scan (xref bridge unavailable) — heuristic; not scoped to a declaring type._\n`;
    if (wantsMethod && !owner && !isAotPath) {
      output += `> ℹ️ This counts every method named \`${ftsName}\` regardless of owner. For a type-scoped where-used, pass \`ownerName\` or qualify as \`Owner.${ftsName}\`.\n`;
    }
    output += `\n`;

    // Cross-type check: detect when the caller used a form/table/view name as if it were a class
    const typeMismatchSection = parentObjectName
      ? buildObjectTypeMismatchMessage(symbolIndex.getReadDb(), parentObjectName)
      : '';

    if (limitedReferences.length === 0) {
      output += `No references found for \`${targetName}\`.\n\n`;
      output += `**Possible reasons:**\n`;
      output += `- Symbol might be unused\n`;
      output += `- Symbol might be defined but not yet indexed\n`;
      output += `- Try search without targetType to broaden results\n`;
      if (typeMismatchSection) {
        output += `\n${typeMismatchSection}`;
      }
    } else {
      // Group by reference type
      const byType = groupByReferenceType(limitedReferences);

      output += `## 📊 Summary by Type\n\n`;
      for (const [type, refs] of Object.entries(byType)) {
        output += `- **${type}**: ${refs.length} reference(s)\n`;
      }
      output += `\n`;

      // Show top callers
      if (summary.topCallers.length > 0) {
        output += `## 🔝 Top Callers\n\n`;
        for (const caller of summary.topCallers.slice(0, 10)) {
          output += `- **${caller.caller}** (${caller.count} call(s))\n`;
        }
        output += `\n`;
      }

      // List all references
      output += `## 📍 All References\n\n`;
      for (const ref of limitedReferences) {
        output += `### ${ref.referenceType} in \`${ref.file}\`\n\n`;
        output += `**Model:** ${ref.model}\n`;
        if (ref.caller) {
          output += `**Caller:** ${ref.caller}\n`;
        }
        if (includeContext && ref.context) {
          output += `\n**Context:**\n\`\`\`xpp\n${ref.context}\n\`\`\`\n`;
        }
        output += `\n`;
      }

      // Show type mismatch hint even when some references were found
      // (they might be false positives from fuzzy matching)
      if (typeMismatchSection) {
        output += `\n---\n\n${typeMismatchSection}`;
      }
    }

    const finalResult = {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };

    // Cache for 30 minutes (references are more volatile than class/table metadata)
    // await cache.set(cacheKey, finalResult, 1800);

    return finalResult;
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error finding references: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Run an FTS5 search on source_snippet (and optionally extra columns) for method symbols.
 * Dramatically faster than `source_snippet LIKE '%term%'` — uses the pre-built FTS index.
 * FTS5 tokenizes on non-word characters (., :, (, ), etc.) so the bare symbol name matches
 * all surrounding call patterns (.name(, ::name(, new name(, etc.).
 * Falls back to an empty array when the FTS query fails (e.g. single-char or reserved word).
 */
function ftsMethodSearch(db: any, term: string, limit: number, extraColumns?: string): any[] {
  // Strip chars that would break FTS5 query syntax
  const safe = term.replace(/["\(\)\\]/g, '').trim();
  if (!safe) return [];
  const cols = extraColumns ? `{source_snippet ${extraColumns}}` : '{source_snippet}';
  const ftsQuery = `${cols} : "${safe}"`;
  try {
    const stmt = db.prepare(`
      SELECT s.name, s.parent_name, s.file_path, s.model, s.source_snippet
      FROM symbols s
      WHERE s.type = 'method'
        AND s.id IN (SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?)
      LIMIT ?
    `);
    return stmt.all(ftsQuery, limit) as any[];
  } catch {
    return [];
  }
}

/**
 * Find method call references
 */
function findMethodReferences(symbolIndex: any, methodName: string, _scope: string, limit: number): Reference[] {
  const references: Reference[] = [];
  const rdb = symbolIndex.getReadDb();

  const rows = ftsMethodSearch(rdb, methodName, limit * 3, 'signature');

  for (const row of rows) {
    const context = extractMethodCallContext(row.source_snippet, methodName);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'call',
        caller: row.parent_name ? `${row.parent_name}.${row.name}` : row.name,
      });
    }
  }

  return references;
}

/**
 * Find class references (extends, implements, instantiations)
 */
function findClassReferences(symbolIndex: any, className: string, _scope: string, limit: number): Reference[] {
  const references: Reference[] = [];
  const rdb = symbolIndex.getReadDb();

  // 1. Find classes that extend this class
  const extendsStmt = rdb.prepare(`
    SELECT name, file_path, model, extends_class
    FROM symbols
    WHERE type = 'class'
      AND extends_class = ?
    LIMIT ?
  `);

  const extendRows = extendsStmt.all(className, limit);
  for (const row of extendRows) {
    references.push({
      file: row.file_path,
      model: row.model,
      context: `class ${row.name} extends ${className}`,
      referenceType: 'extends',
      caller: row.name,
    });
  }

  // 2. Find classes that implement this interface
  const implementsStmt = rdb.prepare(`
    SELECT name, file_path, model, implements_interfaces
    FROM symbols
    WHERE type = 'class'
      AND implements_interfaces LIKE ?
    LIMIT ?
  `);

  const implRows = implementsStmt.all(`%${className}%`, limit);
  for (const row of implRows) {
    if (row.implements_interfaces && row.implements_interfaces.includes(className)) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: `class ${row.name} implements ${className}`,
        referenceType: 'implements',
        caller: row.name,
      });
    }
  }

  // 3. Find instantiations (new ClassName())
  // FTS5: search for className in source_snippet; extractInstantiationContext filters for 'new ClassName('
  const instRows = ftsMethodSearch(rdb, className, limit);
  for (const row of instRows) {
    const context = extractInstantiationContext(row.source_snippet, className);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'instantiation',
        caller: row.parent_name ? `${row.parent_name}.${row.name}` : row.name,
      });
    }
  }

  // 4. Find general type references (classStr(), variable declarations, static calls)
  // FTS5: a single indexed lookup replaces three LIKE full-table scans
  const typeRefRows = ftsMethodSearch(rdb, className, limit);
  const existingCallers = new Set(references.map(r => r.caller));
  for (const row of typeRefRows) {
    const caller = row.parent_name ? `${row.parent_name}.${row.name}` : row.name;
    if (existingCallers.has(caller)) continue; // skip duplicates
    const context = extractTableReferenceContext(row.source_snippet, className);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'type-reference',
        caller,
      });
      existingCallers.add(caller);
    }
  }

  return references;
}

/**
 * Find table references (select statements, table buffers)
 */
function findTableReferences(symbolIndex: any, tableName: string, _scope: string, limit: number): Reference[] {
  const references: Reference[] = [];
  const rdb = symbolIndex.getReadDb();

  const rows = ftsMethodSearch(rdb, tableName, limit);

  for (const row of rows) {
    const context = extractTableReferenceContext(row.source_snippet, tableName);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'type-reference',
        caller: row.parent_name ? `${row.parent_name}.${row.name}` : row.name,
      });
    }
  }

  return references;
}

/**
 * Find field references
 */
function findFieldReferences(symbolIndex: any, fieldName: string, _scope: string, limit: number): Reference[] {
  const references: Reference[] = [];
  const rdb = symbolIndex.getReadDb();

  const rows = ftsMethodSearch(rdb, fieldName, limit);

  for (const row of rows) {
    const context = extractFieldAccessContext(row.source_snippet, fieldName);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'field-access',
        caller: row.parent_name ? `${row.parent_name}.${row.name}` : row.name,
      });
    }
  }

  return references;
}

/**
 * Find enum references
 */
function findEnumReferences(symbolIndex: any, enumName: string, _scope: string, limit: number): Reference[] {
  const references: Reference[] = [];
  const rdb = symbolIndex.getReadDb();

  const rows = ftsMethodSearch(rdb, enumName, limit);

  for (const row of rows) {
    const context = extractEnumReferenceContext(row.source_snippet, enumName);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'type-reference',
        caller: row.parent_name ? `${row.parent_name}.${row.name}` : row.name,
      });
    }
  }

  return references;
}

/**
 * Extract context around method call
 */
function extractMethodCallContext(source: string, methodName: string): string | null {
  if (!source) return null;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(methodName + '(')) {
      // Return 2 lines before and after
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length, i + 3);
      return lines.slice(start, end).join('\n').trim();
    }
  }

  return null;
}

/**
 * Extract context around instantiation
 */
function extractInstantiationContext(source: string, className: string): string | null {
  if (!source) return null;

  const pattern = `new ${className}(`;
  const lines = source.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(pattern)) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      return lines.slice(start, end).join('\n').trim();
    }
  }

  return null;
}

/**
 * Extract context around table reference
 */
function extractTableReferenceContext(source: string, tableName: string): string | null {
  if (!source) return null;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(tableName)) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      return lines.slice(start, end).join('\n').trim();
    }
  }

  return null;
}

/**
 * Extract context around field access
 */
function extractFieldAccessContext(source: string, fieldName: string): string | null {
  if (!source) return null;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('.' + fieldName)) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      return lines.slice(start, end).join('\n').trim();
    }
  }

  return null;
}

/**
 * Extract context around enum reference
 */
function extractEnumReferenceContext(source: string, enumName: string): string | null {
  if (!source) return null;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(enumName + '::')) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      return lines.slice(start, end).join('\n').trim();
    }
  }

  return null;
}

/**
 * Generate reference summary
 */
function generateReferenceSummary(references: Reference[]): {
  topCallers: Array<{ caller: string; count: number }>;
} {
  const callerCounts = new Map<string, number>();

  for (const ref of references) {
    if (ref.caller) {
      callerCounts.set(ref.caller, (callerCounts.get(ref.caller) || 0) + 1);
    }
  }

  const topCallers = Array.from(callerCounts.entries())
    .map(([caller, count]) => ({ caller, count }))
    .sort((a, b) => b.count - a.count);

  return { topCallers };
}

/**
 * Group references by type
 */
function groupByReferenceType(references: Reference[]): Record<string, Reference[]> {
  const groups: Record<string, Reference[]> = {};

  for (const ref of references) {
    if (!groups[ref.referenceType]) {
      groups[ref.referenceType] = [];
    }
    groups[ref.referenceType].push(ref);
  }

  return groups;
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.
