import { useState } from 'react';
import { LEVEL_MARKER, LEVEL_TEXT } from '../format.js';
import { Icon } from './icons.js';
import { readLegendOpen, writeLegendOpen } from './legend-state.js';
const THINGS = [
  { icon: 'ghost', term: 'Ghost', meaning: 'errors' },
  { icon: 'fog', term: 'Fog', meaning: 'latency' },
  { icon: 'darkroom', term: 'Dark room', meaning: 'the service is down' },
  { icon: 'lantern', term: 'Lantern', meaning: 'healthy' },
  { icon: 'mist', term: 'Green mist', meaning: 'the Exorcist is investigating' },
] as const;
const LEVELS = [0, 1, 2, 3, 4] as const;
/** A short key to the picture. Open on a first visit; after that it stays as the visitor left it. */
export function Legend() {
  const [initial] = useState(readLegendOpen);
  return (
    <details className="legend" open={initial}>
      <summary onClick={(event) => writeLegendOpen(!(event.currentTarget.parentElement as HTMLDetailsElement).open)}>What am I looking at?</summary>
      <ul className="legend-things">
        {THINGS.map((t) => (
          <li key={t.term} data-thing={t.icon}>
            <span className="legend-glyph">
              <Icon name={t.icon} size={20} />
            </span>
            <span>
              <strong>{t.term}</strong> = {t.meaning}
            </span>
          </li>
        ))}
      </ul>
      <p className="legend-title" id="legend-levels">
        Haunt levels
      </p>
      <ul className="legend-levels" aria-labelledby="legend-levels">
        {LEVELS.map((l) => (
          <li key={l}>
            <span className="marker" aria-hidden="true">
              {LEVEL_MARKER[l]}
            </span>{' '}
            {LEVEL_TEXT[l]}
          </li>
        ))}
      </ul>
    </details>
  );
}
