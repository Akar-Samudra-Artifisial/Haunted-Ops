import { useCallback, useState } from 'react';
import { usePrefersReducedMotion } from '../scene/hooks.js';
import { parseModeParam, resolveMode, type ModeSource, type SavedChoice, type UrlMode } from './mode.js';
import { readSavedChoice, writeSavedChoice } from './storage.js';
interface Inputs {
  urlMode: UrlMode;
  saved: SavedChoice;
}
function readInputs(): Inputs {
  const search = typeof window === 'undefined' ? '' : window.location.search;
  return { urlMode: parseModeParam(search), saved: readSavedChoice() };
}
/**
 * Accessible mode for the page. The URL and the saved choice are read once; Reduced motion is followed while the
 * page is open, so it decides only when nothing else does. `toggle` flips the mode and saves it; `?mode=scene`
 * never writes anything on load.
 */
export function useAccessibleMode(): { accessible: boolean; source: ModeSource; toggle: () => void } {
  const reducedMotion = usePrefersReducedMotion();
  const [inputs, setInputs] = useState<Inputs>(readInputs);
  const { accessible, source } = resolveMode({ ...inputs, reducedMotion });
  const toggle = useCallback(() => {
    const choice = accessible ? 'off' : 'on';
    // A failed write keeps the new mode for this session.
    writeSavedChoice(choice);
    // The press replaces a mode the URL forced.
    setInputs({ urlMode: null, saved: choice });
  }, [accessible]);
  return { accessible, source, toggle };
}
