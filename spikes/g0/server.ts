// G0 spike: minimal stdio MCP server (throwaway). No dependencies.
// Run: node --experimental-strip-types spikes/g0/server.ts
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. Logs go to stderr.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(here, "out", "diagnosis.json");

type Json = Record<string, unknown>;

const tools = [
  {
    name: "query_metrics",
    description: "Return error-rate metrics for a service. Fixture data.",
    inputSchema: {
      type: "object",
      properties: { service: { type: "string", maxLength: 32 } },
      required: ["service"],
      additionalProperties: false,
    },
  },
  {
    name: "diff_commit",
    description: "Return the diff of a commit or deploy id. Fixture data.",
    inputSchema: {
      type: "object",
      properties: { commit: { type: "string", maxLength: 40 } },
      required: ["commit"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_diagnosis",
    description: "Submit the final diagnosis. Call exactly once.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", maxLength: 500 },
        evidence: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", maxLength: 32 },
              ref: { type: "string", maxLength: 64 },
              detail: { type: "string", maxLength: 300 },
            },
            required: ["kind", "ref", "detail"],
            additionalProperties: false,
          },
        },
        culprit_commit: { type: "string", maxLength: 40 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["summary", "evidence", "culprit_commit", "confidence"],
      additionalProperties: false,
    },
  },
];

function untrusted(text: string): string {
  return `<untrusted_data>\n${text}\n</untrusted_data>`;
}

function queryMetrics(args: Json): string {
  const service = String(args.service ?? "");
  if (service !== "payments") {
    return JSON.stringify({ service, error_rate: [{ t: "-30m", value: 0.002 }, { t: "now", value: 0.002 }] });
  }
  return JSON.stringify({
    service: "payments",
    metric: "http_5xx_ratio",
    series: [
      { t: "-30m", value: 0.002 },
      { t: "-10m", value: 0.002, note: "deploy d-102 lands at -9m" },
      { t: "-5m", value: 0.31 },
      { t: "now", value: 0.31 },
    ],
    deploys: [{ id: "d-102", commit: "c0ffee1", at: "-9m" }],
  });
}

function diffCommit(args: Json): string {
  const commit = String(args.commit ?? "");
  if (commit !== "c0ffee1" && commit !== "d-102") {
    return JSON.stringify({ error: "unknown commit", commit });
  }
  return untrusted(
    [
      "commit c0ffee1 (deploy d-102)",
      "message: simplify refund lookup",
      "--- a/payments/refund.ts",
      "+++ b/payments/refund.ts",
      "@@ -12,7 +12,6 @@ export function refundTarget(order) {",
      "-  if (!order.customer) return null;",
      "   return order.customer.account.id;",
    ].join("\n"),
  );
}

function validDiagnosis(a: Json): string | null {
  if (typeof a.summary !== "string" || a.summary.length === 0) return "summary must be a non-empty string";
  if (!Array.isArray(a.evidence) || a.evidence.length === 0) return "evidence must be a non-empty array";
  for (const e of a.evidence as Json[]) {
    if (typeof e?.kind !== "string" || typeof e?.ref !== "string" || typeof e?.detail !== "string") {
      return "each evidence item needs string kind, ref, detail";
    }
  }
  if (typeof a.culprit_commit !== "string" || a.culprit_commit.length === 0) return "culprit_commit must be a string";
  if (typeof a.confidence !== "number" || a.confidence < 0 || a.confidence > 1) return "confidence must be 0..1";
  const allowed = new Set(["summary", "evidence", "culprit_commit", "confidence"]);
  for (const k of Object.keys(a)) if (!allowed.has(k)) return `unknown field ${k}`;
  return null;
}

let submitted = false;

function callTool(name: string, args: Json): { text: string; isError?: boolean } {
  if (name === "query_metrics") return { text: queryMetrics(args) };
  if (name === "diff_commit") return { text: diffCommit(args) };
  if (name === "submit_diagnosis") {
    if (submitted) return { text: "already submitted", isError: true };
    const problem = validDiagnosis(args);
    if (problem) return { text: `invalid diagnosis: ${problem}`, isError: true };
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify(args, null, 2) + "\n");
    submitted = true;
    return { text: "diagnosis recorded" };
  }
  return { text: `unknown tool ${name}`, isError: true };
}

function send(msg: Json): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

function handle(line: string): void {
  let req: Json;
  try {
    req = JSON.parse(line) as Json;
  } catch {
    return;
  }
  const id = req.id;
  const method = req.method as string | undefined;
  if (method === undefined || id === undefined) return; // notifications and responses
  switch (method) {
    case "initialize": {
      const p = (req.params ?? {}) as Json;
      send({
        id,
        result: {
          protocolVersion: typeof p.protocolVersion === "string" ? p.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "g0-exorcist-mcp", version: "0.0.0" },
        },
      });
      break;
    }
    case "tools/list":
      send({ id, result: { tools } });
      break;
    case "tools/call": {
      const p = (req.params ?? {}) as Json;
      const r = callTool(String(p.name ?? ""), (p.arguments ?? {}) as Json);
      send({ id, result: { content: [{ type: "text", text: r.text }], isError: r.isError === true } });
      break;
    }
    case "ping":
      send({ id, result: {} });
      break;
    default:
      send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
