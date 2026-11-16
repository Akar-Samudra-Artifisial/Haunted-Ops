import type { ReplayFile } from '@haunted-ops/shared';
import { Icon } from '../components/icons.js';
import { SPEEDS, positionText, type PlayerAction, type PlayerState } from './player.js';
/** The controls of a replay: one toolbar, keyboard reachable, labelled, with the focus ring of the page. */
export function ReplayControls({ file, state, dispatch }: { file: Pick<ReplayFile, 'title' | 'durationMs'>; state: PlayerState; dispatch: (action: PlayerAction) => void }) {
  return (
    <section className="replay-controls" aria-labelledby="replay-title">
      <h2 id="replay-title">Replay: {file.title}</h2>
      <div className="replay-buttons" role="toolbar" aria-label="Replay controls">
        <button type="button" aria-pressed={state.playing} onClick={() => dispatch({ type: 'toggle' })}>
          <Icon name={state.playing ? 'pause' : 'play'} />
          Play
        </button>
        <button type="button" onClick={() => dispatch({ type: 'prev' })}>
          <Icon name="prev" />
          Previous frame
        </button>
        <button type="button" onClick={() => dispatch({ type: 'next' })}>
          <Icon name="next" />
          Next frame
        </button>
        <div role="group" aria-label="Speed" className="replay-speed">
          {SPEEDS.map((speed) => (
            <button key={speed} type="button" aria-pressed={state.speed === speed} onClick={() => dispatch({ type: 'speed', speed })}>
              {speed}×
            </button>
          ))}
        </div>
        <a className="button" href="/">
          <Icon name="back" />
          Back to live
        </a>
      </div>
      <label className="replay-position">
        <span>Position</span>
        <input
          type="range"
          min={0}
          max={file.durationMs}
          step={1000}
          value={state.position}
          aria-valuetext={positionText(state.position, file.durationMs)}
          onChange={(e) => dispatch({ type: 'seek', ms: e.currentTarget.valueAsNumber })}
        />
        <span className="num" aria-hidden="true">
          {positionText(state.position, file.durationMs)}
        </span>
      </label>
    </section>
  );
}
