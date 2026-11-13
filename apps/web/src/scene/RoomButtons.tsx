import { useRef, type KeyboardEvent } from 'react';
import type { ServiceName } from '@haunted-ops/shared';
import type { SceneLayout } from './layout.js';
import type { SceneModel } from './model.js';
import { isNavKey, nextRoom } from './selection.js';

/** "payments, haunted, error rate 22%, incident open": the spoken name of a room. */
export function roomButtonLabel(summary: string): string {
  return summary.replace(': ', ', ');
}

function clipPath(polygon: readonly { x: number; y: number }[]): string {
  return `polygon(${polygon.map((p) => `${p.x.toFixed(1)}px ${p.y.toFixed(1)}px`).join(', ')})`;
}

/**
 * One button per room over the drawing, shaped like the silhouette of the room. Tab visits them in
 * room order; arrow keys move to the nearest room; focus or a click selects the room; Escape clears.
 */
export function RoomButtons({
  layout,
  model,
  selected,
  onSelect,
}: {
  layout: SceneLayout;
  model: SceneModel;
  selected: ServiceName | null;
  onSelect: (name: ServiceName | null) => void;
}) {
  const buttons = useRef(new Map<ServiceName, HTMLButtonElement>());

  const onKeyDown = (name: ServiceName) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') {
      onSelect(null);
      return;
    }
    if (!isNavKey(event.key)) return;
    event.preventDefault();
    const next = nextRoom(layout.rooms, name, event.key);
    buttons.current.get(next)?.focus();
  };

  return (
    <div role="group" aria-label="Rooms" className="room-buttons">
      {layout.rooms.map((room) => {
        const visual = model.rooms.find((r) => r.name === room.name);
        return (
          <button
            key={room.name}
            ref={(el) => {
              if (el) buttons.current.set(room.name, el);
              else buttons.current.delete(room.name);
            }}
            type="button"
            className="room-button"
            aria-pressed={selected === room.name}
            aria-label={roomButtonLabel(visual?.summary ?? room.name)}
            style={{ left: room.hit.x, top: room.hit.y, width: room.hit.w, height: room.hit.h, clipPath: clipPath(room.hitPolygon) }}
            onFocus={() => onSelect(room.name)}
            onClick={() => onSelect(room.name)}
            onKeyDown={onKeyDown(room.name)}
          />
        );
      })}
    </div>
  );
}
