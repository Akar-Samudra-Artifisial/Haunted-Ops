// Feature: foundation, Property 8: SSE payloads round-trip
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatSseFrame, parseSseFrame, validateSseEvent } from '../src/index.js';
import { namedEventArb } from './arbitraries.js';

describe('Property 8: SSE payloads round-trip', () => {
  it('format then parse gives an equal, valid payload', () => {
    fc.assert(
      fc.property(namedEventArb, ({ name, payload, id }) => {
        const wire = formatSseFrame(id === undefined ? { event: name, data: payload } : { id, event: name, data: payload });
        const parsed = parseSseFrame(wire);
        expect(parsed).not.toBeNull();
        expect(parsed?.event).toBe(name);
        expect(parsed?.id).toBe(id);
        expect(parsed?.data).toEqual(payload);
        expect(validateSseEvent(name, parsed?.data).ok).toBe(true);
        // One frame is exactly one blank-line-terminated block.
        expect(wire.indexOf('\n\n')).toBe(wire.length - 2);
      }),
      { numRuns: 300 },
    );
  });
});
