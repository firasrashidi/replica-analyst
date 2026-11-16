import { spawn } from "node:child_process";
import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { refuseSql } from "../lib/sql-guard";

const ROW_CAP = 100;

type ReplicaEnv = {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
};

type QueryOk = {
  ok: true;
  sessionUser: string;
  rowCount: number;
  truncated: boolean;
  csv: string;
};

type QueryErr = { ok: false; error: string };

export default defineTool({
  description:
    "Run one read-only SQL statement on the read replica as analyst_ro. Use this for every fact about the database. It rejects writes, role changes, file access, and any connection that is not the replica.",
  effect: "read",
  inputSchema: z.object({
    sql: z.string().min(1).max(8_000),
  }),
  async execute({ sql }): Promise<QueryOk | QueryErr> {
    const refused = refuseSql(sql);
    if (refused !== null) return { ok: false, error: refused };

    const replica = readReplicaEnv();
    if (!replica.ok) return replica;

    const probe = await runPsql(replica.env, "select session_user, pg_is_in_recovery();");
    if (probe.code !== 0) return { ok: false, error: connectionError(probe.stderr, replica.secret) };

    const gate = readProbe(probe.stdout);
    if (!gate.ok) return gate;

    const query = await runPsql(replica.env, sql);
    if (query.code !== 0) return { ok: false, error: scrub(query.stderr, replica.secret) || "The query failed." };

    const lines = query.stdout.split(/\r?\n/).filter((line) => line.length > 0);
    const header = lines[0] ?? "";
    const data = lines.slice(1);
    const truncated = data.length > ROW_CAP;
    const kept = data.slice(0, ROW_CAP);
    return {
      ok: true,
      sessionUser: gate.sessionUser,
      rowCount: kept.length,
      truncated,
      csv: [header, ...kept].join("\n"),
    };
  },
});

function readReplicaEnv(): { ok: true; env: ReplicaEnv; secret: string } | QueryErr {
  const raw = process.env.ANALYST_REPLICA_URL;
  if (raw === undefined || raw.trim() === "") {
    return { ok: false, error: "ANALYST_REPLICA_URL is not set. This agent has no database connection." };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "ANALYST_REPLICA_URL is not a valid Postgres URL." };
  }

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    return { ok: false, error: "ANALYST_REPLICA_URL must be a postgres URL." };
  }

  const user = decodeURIComponent(url.username);
  if (user !== "analyst_ro" && !user.startsWith("analyst_ro.")) {
    return { ok: false, error: "The configured login is not analyst_ro." };
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (url.hostname === "" || database === "") {
    return { ok: false, error: "ANALYST_REPLICA_URL is missing a host or database name." };
  }

  return {
    ok: true,
    secret: raw,
    env: {
      host: url.hostname,
      port: url.port === "" ? "5432" : url.port,
      user,
      password: decodeURIComponent(url.password),
      database,
    },
  };
}

function readProbe(csv: string): { ok: true; sessionUser: string } | QueryErr {
  const lines = csv.split(/\r?\n/).filter((line) => line.length > 0);
  const row = lines[1]?.split(",") ?? [];
  const sessionUser = row[0] ?? "";
  const inRecovery = (row[1] ?? "").trim().toLowerCase();
  if (sessionUser !== "analyst_ro") {
    return { ok: false, error: "This connection is not the analyst_ro role." };
  }
  if (inRecovery !== "t" && inRecovery !== "true") {
    return { ok: false, error: "This connection is the primary. This agent only queries the read replica." };
  }
  return { ok: true, sessionUser };
}

function connectionError(stderr: string, secret: string): string {
  if (stderr.includes("may only connect to the read replica")) {
    return "This login is not on the read replica.";
  }
  const detail = scrub(stderr, secret);
  return detail === "" ? "Could not open the read replica." : `Could not open the read replica. ${detail}`;
}

function scrub(text: string, secret: string): string {
  let clean = text.replaceAll(secret, "[redacted]");
  try {
    const password = decodeURIComponent(new URL(secret).password);
    if (password !== "") clean = clean.replaceAll(password, "[redacted]");
  } catch {
    // The URL was already validated by the caller when secret is a URL.
  }
  return clean.replace(/\s+/g, " ").trim().slice(0, 300);
}

function runPsql(env: ReplicaEnv, sql: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "psql",
      ["-X", "-q", "-v", "ON_ERROR_STOP=1", "--csv", "-c", sql],
      {
        env: {
          PATH: process.env.PATH ?? "",
          PGHOST: env.host,
          PGPORT: env.port,
          PGUSER: env.user,
          PGPASSWORD: env.password,
          PGDATABASE: env.database,
          PGSSLMODE: "require",
          PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=15000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 20_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      resolve({
        code: 1,
        stdout: "",
        stderr: missing ? "psql is not installed on this machine." : error.message,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
