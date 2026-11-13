import type { ServiceName } from '@haunted-ops/shared';
import type { RoomLayout } from './layout.js';

export type NavKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

export const NAV_KEYS: readonly NavKey[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];

export function isNavKey(key: string): key is NavKey {
  return (NAV_KEYS as readonly string[]).includes(key);
}

/** Tab order: the reading order of the layout (row, then column). */
export function tabOrder(rooms: readonly RoomLayout[]): ServiceName[] {
  return rooms.map((r) => r.name);
}

const EPS = 1e-6;

/**
 * The Room to focus after a key. An arrow key looks at the Rooms whose centre lies in that screen
 * direction and takes the one with the smallest `along + 3 * across` distance (ties by reading
 * order). With none it stays. Home and End go to the first and last Room.
 */
export function nextRoom(rooms: readonly RoomLayout[], current: ServiceName, key: NavKey): ServiceName {
  if (rooms.length === 0) return current;
  if (key === 'Home') return (rooms[0] as RoomLayout).name;
  if (key === 'End') return (rooms[rooms.length - 1] as RoomLayout).name;
  const here = rooms.find((r) => r.name === current);
  if (!here) return (rooms[0] as RoomLayout).name;
  let best: RoomLayout | null = null;
  let bestCost = Infinity;
  for (const r of rooms) {
    if (r === here) continue;
    const dx = r.center.x - here.center.x;
    const dy = r.center.y - here.center.y;
    let along: number;
    let across: number;
    switch (key) {
      case 'ArrowRight':
        [along, across] = [dx, dy];
        break;
      case 'ArrowLeft':
        [along, across] = [-dx, dy];
        break;
      case 'ArrowDown':
        [along, across] = [dy, dx];
        break;
      case 'ArrowUp':
        [along, across] = [-dy, dx];
        break;
    }
    if (along <= EPS) continue;
    const cost = along + 3 * Math.abs(across);
    if (cost < bestCost - EPS) {
      best = r;
      bestCost = cost;
    }
  }
  return (best ?? here).name;
}

export type SelectionAction =
  | { type: 'select'; name: ServiceName }
  | { type: 'toggle'; name: ServiceName }
  | { type: 'clear' };

export function selectionReducer(state: ServiceName | null, action: SelectionAction): ServiceName | null {
  switch (action.type) {
    case 'select':
      return action.name;
    case 'toggle':
      return state === action.name ? null : action.name;
    case 'clear':
      return null;
  }
}
