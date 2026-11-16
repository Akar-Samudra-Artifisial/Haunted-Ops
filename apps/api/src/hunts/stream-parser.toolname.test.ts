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

  it('is an empty string when the key is not text, and is cut at 60 characters', () => {
    const bad = classify(event({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'x', rawInput: {}, _meta: { kiro: { toolName: { x: 1 } } } }));
    expect(bad).toMatchObject({ toolName: '' });
    const long = classify(event({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'x', rawInput: {}, _meta: { kiro: { toolName: 'r'.repeat(500) } } }));
    expect((long as { toolName: string }).toolName).toHaveLength(60);
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
  it('is absent when it is not text, and is cut at 64 characters', () => {
    for (const bad of [5, null, { x: 1 }, ['exorcist'], true]) expect('mcpServerName' in classify(event(meta({ mcpServerName: bad })))).toBe(false);
    const long = classify(event(meta({ mcpServerName: 'e'.repeat(500) })));
    expect((long as { mcpServerName: string }).mcpServerName).toHaveLength(64);
  });
});
