import { useEffect, useRef, useState } from 'react';
import type { HauntLevel, ServiceName, ServiceState } from '@haunted-ops/shared';
import { LEVEL_TEXT } from '../format.js';

/** Sentences for the services whose level changed. A service seen for the first time is silent. */
export function levelChanges(
  previous: ReadonlyMap<ServiceName, HauntLevel>,
  services: readonly ServiceState[],
): string[] {
  const out: string[] = [];
  for (const s of services) {
    const before = previous.get(s.name);
    if (before !== undefined && before !== s.hauntLevel) out.push(`${s.name}: ${LEVEL_TEXT[s.hauntLevel]}`);
  }
  return out;
}

/** Visually hidden polite live region: one short sentence per level change, nothing on first load. */
export function LiveAnnouncer({ services }: { services: readonly ServiceState[] }) {
  const previous = useRef<Map<ServiceName, HauntLevel>>(new Map());
  const [message, setMessage] = useState('');

  useEffect(() => {
    const changes = levelChanges(previous.current, services);
    previous.current = new Map(services.map((s) => [s.name, s.hauntLevel]));
    if (changes.length > 0) setMessage(changes.join('. '));
  }, [services]);

  return (
    <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="level-announcer">
      {message}
    </div>
  );
}
