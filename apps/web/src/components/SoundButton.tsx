import { Icon } from './icons.js';

export interface SoundSwitch {
  on: boolean;
  unavailable: boolean;
  onToggle: () => void;
}

/** The sound button: quiet and secondary like the Accessible mode switch. Off by default; its state is in `aria-pressed` and in the words. */
export function SoundButton({ on, unavailable, onToggle }: SoundSwitch) {
  return (
    <button type="button" className="a11y-switch sound-switch" aria-pressed={unavailable ? false : on} disabled={unavailable} onClick={onToggle}>
      <Icon name={on && !unavailable ? 'speaker' : 'speaker-off'} size={16} />
      <span>{unavailable ? 'Sound unavailable' : on ? 'Sound on' : 'Sound off'}</span>
    </button>
  );
}
