// Feature: scene-engine, Property 6: the model and the table agree
import fc from 'fast-check';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES, type ServiceState } from '@haunted-ops/shared';
import { ROOMS, serviceStateArb } from '../test/arbs.js';
import { toSceneModel } from '../scene/model.js';
import { TableMode } from './TableMode.js';
import { tableRowText } from './table-model.js';

const NOW = Date.parse('2026-11-13T10:00:00.000Z');

/** 1 to 4 distinct services in their standard rooms, each in a random state. */
const houseArb: fc.Arbitrary<ServiceState[]> = fc
  .tuple(fc.subarray([...SERVICE_NAMES], { minLength: 1 }), fc.array(serviceStateArb, { minLength: 4, maxLength: 4 }))
  .map(([names, states]) => names.map((name, i) => ({ ...states[i]!, name, room: ROOMS[name] })));

describe('Property 6: the model and the table agree', () => {
  it('shows the same level, reason, dark or lit state and incident for every service', () => {
    fc.assert(
      fc.property(houseArb, fc.boolean(), (services, reducedMotion) => {
        const model = toSceneModel(services, NOW, { reducedMotion, quality: 'full' });
        const doc = document.createElement('div');
        doc.innerHTML = renderToStaticMarkup(<TableMode services={services} />);
        const rows = [...doc.querySelectorAll('tbody tr')];
        expect(rows).toHaveLength(model.rooms.length);
        model.rooms.forEach((room, i) => {
          const row = rows[i] as Element;
          const cells = [...row.querySelectorAll('td')].map((c) => c.textContent ?? '');
          expect(row.querySelector('th')?.textContent?.replace('▶', '').trim()).toBe(room.name);
          // Level: number and label, the same words the scene uses.
          expect(cells[0]).toContain(`${room.level} (${room.levelLabel})`);
          // Reason: the Badge text, with "none" exactly when the Badge is empty.
          expect(cells[1]).toBe(room.badge === '' ? 'none' : room.badge);
          // Dark or lit: the table says "dark" in the level cell exactly when the Room is dark.
          expect(/dark/.test(cells[0] as string)).toBe(room.dark);
          expect(row.getAttribute('data-room-state')).toBe(room.dark ? 'dark' : 'lit');
          // Incident.
          expect(cells[5] === 'none').toBe(!room.incident.open);
          if (room.incident.open) expect(cells[5]).toContain(`peak ${room.incident.peakLevel}`);
        });
      }),
      { numRuns: 150 },
    );
  });

  it('uses the same text function for the row as the one tested', () => {
    fc.assert(
      fc.property(serviceStateArb, (s) => {
        const text = tableRowText(s);
        const room = toSceneModel([s], NOW, { reducedMotion: false, quality: 'full' }).rooms[0]!;
        expect(text.dark).toBe(room.dark);
        expect(text.reason).toBe(room.badge === '' ? 'none' : room.badge);
      }),
      { numRuns: 150 },
    );
  });
});
