/** The toggle for Accessible mode: a real button, with its state in `aria-pressed` and in a symbol beside the label. */
export function AccessibleSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="a11y-switch" aria-pressed={on} onClick={onToggle}>
      <span aria-hidden="true">{on ? '✓' : '○'} </span>
      Accessible mode
    </button>
  );
}
