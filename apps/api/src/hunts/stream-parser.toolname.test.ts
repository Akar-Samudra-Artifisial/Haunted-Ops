import { describe, expect, it } from 'vitest';
import { classify } from './stream-parser.js';

const event = (update: Record<string, unknown>): unknown => ({ type: 'sessionUpdate', data: { sessionId: 's', update } });

describe('the stable tool name of kiro-cli 3.3.0 (`_meta.kiro.toolName`)', () => {
  it('is carried by a tool call and an update, and absent when the event has none', () => {
    const call = classify(event({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Reading a.ts:1', kind: 'read', rawInput: {}, _meta: { kiro: { toolName: 'read' } } }));
    expect(call).toMatchObject({ type: 'tool_call', toolName: 'read', kind: 'read' });
    const upd = classify(event({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', _meta: { kiro: { toolName: 'write' } } }));
    expect(upd).toMatchObject({ type: 'tool_call_update', toolName: 'write' });
    expect('toolName' in classify(event({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Read File', rawInput: {} }))).toBe(false);
    expect('toolName' in classify(event({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'x', rawInput: {}, _meta: { kiro: {} } }))).toBe(false);
  });

  it('is an empty string when the key is present but not text of 1 to 64 characters', () => {
    for (const bad of [5, null, { x: 1 }, ['read'], true, '', 'r'.repeat(65), 'r'.repeat(500)]) {
      const ev = classify(event({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'x', rawInput: {}, _meta: { kiro: { toolName: bad } } }));
      expect(ev, JSON.stringify(bad).slice(0, 20)).toMatchObject({ toolName: '' });
    }
    expect(classify(event({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'x', rawInput: {}, _meta: { kiro: { toolName: 'r'.repeat(64) } } }))).toMatchObject({ toolName: 'r'.repeat(64) });
  });
});
describe('the MCP server name of kiro-cli 3.3.0 (`_meta.kiro.mcpServerName`)', () => {
  const meta = (kiro: Record<string, unknown>): Record<string, unknown> => ({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Running: @exorcist/tail_logs', rawInput: {}, _meta: { kiro } });
  it('is carried by a tool call and an update next to the tool name, and absent when the event has none', () => {
    expect(classify(event(meta({ toolName: 'tail_logs', mcpServerName: 'exorcist' })))).toMatchObject({ type: 'tool_call', toolName: 'tail_logs', mcpServerName: 'exorcist' });
    expect(classify(event({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', _meta: { kiro: { mcpServerName: 'exorcist' } } }))).toMatchObject({ type: 'tool_call_update', mcpServerName: 'exorcist' });
    expect('mcpServerName' in classify(event(meta({ toolName: 'tail_logs' })))).toBe(false);
    expect('mcpServerName' in classify(event({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'x', rawInput: {} }))).toBe(false);
  });
  it('is an empty string when the key is present but not text of 1 to 64 characters', () => {
    for (const bad of [5, null, { x: 1 }, ['exorcist'], true, '', 'e'.repeat(65), 'e'.repeat(500)]) {
      expect(classify(event(meta({ mcpServerName: bad }))), JSON.stringify(bad).slice(0, 20)).toMatchObject({ mcpServerName: '' });
      expect(classify(event({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', _meta: { kiro: { mcpServerName: bad } } })), JSON.stringify(bad).slice(0, 20)).toMatchObject({ mcpServerName: '' });
    }
    expect(classify(event(meta({ mcpServerName: 'e'.repeat(64) })))).toMatchObject({ mcpServerName: 'e'.repeat(64) });
  });
});
