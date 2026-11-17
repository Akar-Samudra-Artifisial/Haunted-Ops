import { Icon } from './icons.js';

export interface SoundSwitch {
  on: boolean;
  unavailable: boolean;
  /** Sound is on and has been quiet for 20 s: the button's title and its description say when sounds play. */
  hint?: boolean;
  onToggle: () => void;
}

/** The sound button: quiet and secondary like the Accessible mode switch. Off by default; its state is in `aria-pressed` and in the words. */
export const SOUND_HINT = 'Sounds play when a room changes: ghosts, fog, a dark room, a hunt';
/** "Sound unavailable" is a button too: a click tries again. The hint is plain text (no live announcement, no toast), shown only while sound is on and quiet. */
export function SoundButton({ on, unavailable, hint = false, onToggle }: SoundSwitch) {
  const showHint = hint && on && !unavailable;
  return (
    <>
      <button
        type="button"
        className="a11y-switch sound-switch"
        aria-pressed={unavailable ? false : on}
        aria-describedby={showHint ? 'sound-hint' : undefined}
        title={showHint ? SOUND_HINT : undefined}
        onClick={onToggle}
      >
        <Icon name={on && !unavailable ? 'speaker' : 'speaker-off'} size={16} />
        <span>{unavailable ? 'Sound unavailable' : on ? 'Sound on' : 'Sound off'}</span>
      </button>
      {showHint ? (
        <span id="sound-hint" hidden>
          {SOUND_HINT}
        </span>
      ) : null}
    </>
  );
}
