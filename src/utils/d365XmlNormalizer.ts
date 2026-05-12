/**
 * Normalize content destined for a D365FO metadata XML file on disk so it
 * matches Microsoft's serialization convention:
 *
 *   - no UTF-8 BOM
 *   - CRLF line endings
 *   - no trailing newline
 *
 * Verified empirically by scanning 105,940 OOB XML files across
 * ApplicationFoundation, ApplicationCommon, ApplicationPlatform, and
 * ApplicationSuite\Foundation:
 *
 *   CRLF: 100.00%   (no bare-LF file exists)
 *   no BOM: 98.96%
 *   no trailing newline: 98.44%
 *
 * The MCP server only ever writes to custom-model files it creates or
 * modifies itself — never to OOB Microsoft files — so unconditionally
 * applying the dominant convention (rather than detecting and preserving
 * the rare exceptions) is both correct and simpler.
 *
 * Without this normalization every tool-created file shows up in TFVC/Git
 * as if every line had been modified (CRLF → LF + leading BOM + trailing
 * newline). The C# bridge (which writes via Microsoft's MetadataDiskProvider
 * SDK) already produces files matching the convention; this helper brings
 * the Node-side writers in line.
 */
export function normalizeD365Xml(content: string): string {
  // Strip a leading UTF-8 BOM (U+FEFF)
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }
  // Force CRLF: collapse any existing CRLF to LF first so a mixed-EOL
  // input does not get expanded into double CR (CRCRLF).
  content = content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  // Strip a single trailing newline
  if (content.endsWith('\r\n')) {
    content = content.slice(0, -2);
  } else if (content.endsWith('\n')) {
    content = content.slice(0, -1);
  }
  return content;
}
