import { cleanup, render, screen, within } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVICE_NAMES, type ServiceState } from '@haunted-ops/shared';
import { makeService } from '../test/arbs.js';
import { huntSummaryArb } from '../test/hunt-arbs.js';
import { FULL } from '../test/scene-fakes.js';
import { toSceneModel } from '../scene/model.js';
import { HuntSection, huntSectionService } from './HuntSection.js';
import { huntCellText, huntView } from './hunt-text.js';
import { TableMode } from './TableMode.js';
import { tableRowText } from './table-model.js';

afterEach(() => {
  cleanup();
});

const NOW = Date.parse('2026-11-13T10:00:30.000Z');
const housesArb = fc.array(fc.option(huntSummaryArb, { nil: null }), { minLength: 4, maxLength: 4 }).map((hunts): ServiceState[] =>
  SERVICE_NAMES.map((name, i) => makeService(name, { hunt: hunts[i] === null ? null : { ...(hunts[i] as NonNullable<(typeof hunts)[number]>), service: name } })),
);

// Feature: exorcist-agent, Property 14
describe('Property 14: the scene and the table agree on every hunt', () => {
  it('say the same phase, step count, culprit and reason, in the Room label and the table cell', () => {
    fc.assert(
      fc.property(housesArb, fc.integer({ min: -5_000, max: 120_000 }), (services, dt) => {
        const model = toSceneModel(services, NOW + dt, FULL);
        for (const s of services) {
          const room = model.rooms.find((r) => r.name === s.name)!;
          const view = huntView(s.hunt);
          const cell = tableRowText(s).hunt;
          expect(cell).toBe(huntCellText(view));
          if (s.hunt === null) {
            expect(room.hunt).toBeNull();
            expect(cell).toBe('none');
            continue;
          }
          // The scene draws exactly what the table says.
          expect(room.hunt?.label).toBe(cell);
          expect(room.summary).toContain(`hunt ${cell}`);
          if (view.phase === 'running' && view.stepCount > 0) expect(cell).toContain(`step ${view.stepCount}`);
          expect(room.hunt?.marks).toBe(Math.min(8, s.hunt.stepCount));
          if (view.culprit !== null) {
            expect(room.hunt?.result).toBe('sealed');
            expect(cell).toContain(view.culprit.deploy);
            expect(cell).toContain(view.culprit.shortSha);
          } else if (view.phase === 'failed' || view.phase === 'cancelled') {
            expect(room.hunt?.result).toBe('failed');
            if (view.reasonText !== null) expect(cell).toContain(view.reasonText);
          } else {
            expect(room.hunt?.result).toBe('none');
          }
          expect(['queued', 'entering', 'working', 'sealed', 'fizzled']).toContain(room.hunt?.phase);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('shows the same cell in the rendered table, and the same steps in the Hunt section', () => {
    fc.assert(
      fc.property(housesArb, (services) => {
        cleanup();
        render(<TableMode services={services} />);
        for (const s of services) {
          const row = screen.getByRole('row', { name: new RegExp(`^${s.name}\\b`) });
          const cells = within(row).getAllByRole('cell');
          expect(cells.at(-1)?.textContent).toBe(huntCellText(huntView(s.hunt)));
        }
        const shown = huntSectionService(services, null);
        if (shown?.hunt) {
          const items = screen.queryAllByRole('listitem').map((li) => li.textContent);
          expect(items).toEqual(shown.hunt.steps.map((st) => `step ${st.index}: ${st.summary}`));
        }
      }),
      { numRuns: 60 },
    );
  });

  it('is the same view in the section as in the cell', () => {
    fc.assert(
      fc.property(huntSummaryArb, (h) => {
        cleanup();
        const s = makeService('payments', { hunt: { ...h, service: 'payments' } });
        render(<HuntSection service={s} />);
        expect(screen.getByTestId('hunt-state').textContent).toBe(tableRowText(s).hunt);
      }),
      { numRuns: 60 },
    );
  });
});
