import type { HauntLevel, ServiceState } from '@haunted-ops/shared';

const LEVEL_TEXT: Record<HauntLevel, string> = {
  0: 'calm',
  1: 'uneasy',
  2: 'haunted',
  3: 'heavily haunted',
  4: 'dark',
};

/** Accessible text view of the house. Full content arrives in `accessible-mode`. */
export function TableMode({ services }: { services: readonly ServiceState[] }) {
  return (
    <section className="table-mode" aria-labelledby="table-mode-title">
      <h2 id="table-mode-title">Services</h2>
      <table>
        <caption className="visually-hidden">Current haunt level of each service</caption>
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Haunt level</th>
          </tr>
        </thead>
        <tbody>
          {services.length === 0 ? (
            <tr>
              <td colSpan={2}>No data yet</td>
            </tr>
          ) : (
            services.map((s) => (
              <tr key={s.name}>
                <th scope="row">{s.name}</th>
                <td>
                  {s.hauntLevel} ({LEVEL_TEXT[s.hauntLevel]})
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}
