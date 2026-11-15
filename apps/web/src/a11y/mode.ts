/** The saved choice: what the user last picked with the Switch, or null for no choice. */
export type SavedChoice = 'on' | 'off' | null;
export type UrlMode = 'scene' | 'accessible' | null;
/** Which input decided the mode. */
export type ModeSource = 'url-scene' | 'url-accessible' | 'saved' | 'reduced-motion' | 'default';
export interface ModeInput {
  urlMode: UrlMode;
  saved: SavedChoice;
  reducedMotion: boolean;
}
export interface ModeResult {
  accessible: boolean;
  source: ModeSource;
}
/** The one key the Web keeps in `localStorage`. A new format gets a new key; this one is never migrated. */
export const STORAGE_KEY = 'haunted-ops.a11y.v1';
/**
 * Accessible mode on or off. Order of precedence: `?mode=scene`, `?mode=accessible`, the saved choice,
 * Reduced motion, then off.
 */
export function resolveMode(input: ModeInput): ModeResult {
  if (input.urlMode === 'scene') return { accessible: false, source: 'url-scene' };
  if (input.urlMode === 'accessible') return { accessible: true, source: 'url-accessible' };
  if (input.saved !== null) return { accessible: input.saved === 'on', source: 'saved' };
  if (input.reducedMotion) return { accessible: true, source: 'reduced-motion' };
  return { accessible: false, source: 'default' };
}
/** The `mode` parameter of a query string: only the two exact words count, and the first value wins. */
export function parseModeParam(search: string): UrlMode {
  const value = new URLSearchParams(search).get('mode');
  return value === 'scene' || value === 'accessible' ? value : null;
}
/** The saved choice from its stored text. Anything that is not `{"mode":"on"}` or `{"mode":"off"}` is no choice. */
export function parseSavedChoice(raw: string | null): SavedChoice {
  if (typeof raw !== 'string') return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const mode = (value as { mode?: unknown }).mode;
    return mode === 'on' || mode === 'off' ? mode : null;
  } catch {
    return null;
  }
}
export function serializeChoice(choice: 'on' | 'off'): string {
  return JSON.stringify({ mode: choice });
}
