// G0 spike helper (throwaway): summarize a kiro-cli stream-json run without dumping raw logs.
// Usage: node --experimental-strip-types spikes/g0/summarize-stream.ts <file.jsonl>
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("usage: summarize-stream.ts <file.jsonl>");

const toolCalls: string[] = [];
const toolStatus: string[] = [];
const other: string[] = [];
const eventTypes = new Map<string, number>();
const metaKeys = new Set<string>();
let text = "";
let lastTools = "";

for (const line of readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let ev: any;
  try { ev = JSON.parse(line); } catch { continue; }
  const u = ev?.data?.update;
  const kind = u?.sessionUpdate ?? ev?.type;
  eventTypes.set(kind, (eventTypes.get(kind) ?? 0) + 1);
  if (u?.sessionUpdate === "tool_call") toolCalls.push(`${u.title ?? "?"} [${u.kind ?? "?"}] ${JSON.stringify(u.rawInput ?? {}).slice(0, 80)}`);
  if (u?.sessionUpdate === "tool_call_update" && u.status) {
    const out = JSON.stringify(u.content ?? u.rawOutput ?? "").slice(0, 120);
    toolStatus.push(`${String(u.toolCallId).slice(-6)}:${u.status} ${u.status === "failed" ? out : ""}`);
  }
  if (u?.sessionUpdate === "agent_message_chunk") text += u.content?.text ?? "";
  if (u?.sessionUpdate === "session_info_update") {
    const b = u._meta?.kiro?.breakdown?.tools;
    if (b) lastTools = JSON.stringify(b);
    for (const k of Object.keys(u._meta?.kiro ?? {})) metaKeys.add(k);
    const m = u._meta?.kiro ?? {};
    if (m.credits !== undefined || m.elapsedTime !== undefined || m.turnEnd !== undefined) {
      other.push(`turn: credits=${JSON.stringify(m.credits)} elapsed=${JSON.stringify(m.elapsedTime)} stop=${JSON.stringify(m.stopReason)}`);
    }
  }
  if (ev?.type && !["sessionUpdate", "runStarted"].includes(ev.type)) other.push(`${ev.type}: ${JSON.stringify(ev.data).slice(0, 800)}`);
}

console.log("event types:", Object.fromEntries(eventTypes));
console.log("session_info meta keys:", [...metaKeys]);
console.log("last tools breakdown:", lastTools);
console.log("tool calls:", toolCalls);
console.log("tool status:", toolStatus);
console.log("non-session events:", other);
console.log("agent text:", text.slice(0, 1200));
