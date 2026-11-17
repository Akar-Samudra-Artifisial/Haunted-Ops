import { useRef, type FocusEvent, type KeyboardEvent } from 'react';
import type { ServiceName } from '@haunted-ops/shared';
import type { Pt, RoomLayout, SceneLayout } from './layout.js';
import type { SceneModel } from './model.js';
import { isNavKey, nextRoom } from './selection.js';

/** "payments, haunted, error rate 22%, incident open": the spoken name of a room. */
export function roomButtonLabel(summary: string): string {
  return summary.replace(': ', ', ');
}

function clipPath(polygon: readonly Pt[]): string {
  return `polygon(${polygon.map((p) => `${p.x.toFixed(1)}px ${p.y.toFixed(1)}px`).join(', ')})`;
}

/**
 * One button per room over the drawing, shaped like the outline of the room: `outline` is `roomOutline` handed over by the scene chunk (the
 * outline of the picture with the room pictures, else the silhouette of the layout). Tab visits them in room order; arrow keys move to the nearest
 * room; focus or a click selects the room; Escape clears. `outline` is `null` while the scene is not drawing: the button is then shaped by the
 * silhouette and keeps its CSS focus outline; once it draws, the scene draws the ring of the focused room (`onFocusVisible` tells which).
 */
export function RoomButtons({
  layout,
  model,
  selected,
  onSelect,
  outline = null,
  onFocusVisible,
}: {
  layout: SceneLayout;
  model: SceneModel;
  selected: ServiceName | null;
  onSelect: (name: ServiceName | null) => void;
  outline?: ((room: RoomLayout) => Pt[]) | null;
  onFocusVisible?: (name: ServiceName | null) => void;
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

  const onFocus = (name: ServiceName) => (event: FocusEvent<HTMLButtonElement>) => {
    onSelect(name);
    // Keyboard focus only: a click focuses the button too, and the selection ring already shows that room.
    if (event.currentTarget.matches(':focus-visible')) onFocusVisible?.(name);
  };

  return (
    <div role="group" aria-label="Rooms" className="room-buttons" data-ring={outline === null ? undefined : 'scene'}>
      {layout.rooms.map((room) => {
        const shape = outline === null ? room.silhouette : outline(room);
        const hx = Math.min(...shape.map((p) => p.x));
        const hy = Math.min(...shape.map((p) => p.y));
        const hw = Math.max(...shape.map((p) => p.x)) - hx;
        const hh = Math.max(...shape.map((p) => p.y)) - hy;
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
            style={{ left: hx, top: hy, width: hw, height: hh, clipPath: clipPath(shape.map((p) => ({ x: p.x - hx, y: p.y - hy }))) }}
            onFocus={onFocus(room.name)}
            onBlur={() => onFocusVisible?.(null)}
            onClick={() => onSelect(room.name)}
            onKeyDown={onKeyDown(room.name)}
          />
        );
      })}
    </div>
  );
}
