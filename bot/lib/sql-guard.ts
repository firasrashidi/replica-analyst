// Fail closed before a connection is opened. A miss here must refuse the
// statement, not send it.

const READ_START = /^(select|with|explain|show|values)\b/i;

const BLOCKED_CALL = /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|dblink|dblink_exec|dblink_connect)\s*\(/i;

export function refuseSql(raw: string): string | null {
  const sql = stripLeadingComments(raw).trim();
  if (sql.length === 0) return "SQL is empty.";
  if (sql.startsWith("\\")) return "psql commands are not allowed.";
  if (hasExtraStatement(sql)) return "Send one SQL statement.";

  const head = sql.replace(/^\(+/, "").trimStart();
  if (!READ_START.test(head)) {
    return "Only one read statement is allowed: SELECT, WITH, EXPLAIN, SHOW, or VALUES.";
  }
  if (/\bselect\s+into\b/i.test(sql) || /\binto\s+(temp|temporary|unlogged)\b/i.test(sql)) {
    return "Creating a table is not allowed.";
  }
  if (BLOCKED_CALL.test(sql)) {
    return "That function is not available to this agent.";
  }
  return null;
}

function stripLeadingComments(sql: string): string {
  let rest = sql.trimStart();
  while (rest.length > 0) {
    if (rest.startsWith("--")) {
      const nl = rest.indexOf("\n");
      rest = (nl === -1 ? "" : rest.slice(nl + 1)).trimStart();
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      if (end === -1) return rest;
      rest = rest.slice(end + 2).trimStart();
      continue;
    }
    break;
  }
  return rest;
}

function hasExtraStatement(sql: string): boolean {
  let i = 0;
  let quote: "'" | '"' | null = null;
  while (i < sql.length) {
    const c = sql[i];
    if (quote !== null) {
      if (c === quote) {
        if (sql[i + 1] === quote) {
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      i += 1;
      continue;
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tag !== null) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end === -1) return true;
        i = end + tag[0].length;
        continue;
      }
    }
    if (c === ";") {
      const rest = stripLeadingComments(sql.slice(i + 1)).trim();
      if (rest.length > 0) return true;
    }
    i += 1;
  }
  return false;
}
