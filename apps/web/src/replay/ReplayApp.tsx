import { useEffect, useMemo, useState, type ComponentType } from 'react';
import type { ReplayFile, ReplayListItem } from '@haunted-ops/shared';
import { useAccessibleMode } from '../a11y/useAccessibleMode.js';
import type { AppProps, ReplayRoute } from '../App.js';
import { usePrefersReducedMotion } from '../scene/hooks.js';
import { ReplayControls } from './ReplayControls.js';
import { fetchReplay, fetchReplayList, type ReplayLoad } from './replay-api.js';
import { bannerText, sceneClock, stateAt, timeline } from './player.js';
import { useReplayPlayer } from './useReplayPlayer.js';
/** One request per mount; a result that arrives after the unmount is dropped. `null` while loading. */
function useLoad<T>(load: () => Promise<ReplayLoad<T>>, key: string): ReplayLoad<T> | null {
  const [result, setResult] = useState<{ key: string; load: ReplayLoad<T> } | null>(null);
  useEffect(() => {
    let live = true;
    load().then(
      (r) => live && setResult({ key, load: r }),
      () => live && setResult({ key, load: { status: 'error' } }),
    );
    return () => {
      live = false;
    };
    // The loader is built from the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return result !== null && result.key === key ? result.load : null;
}
/** `2:05` from milliseconds. */
function durationText(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="replay-page">
      <h1>{title}</h1>
      {children}
      <p>
        <a className="button" href="/">
          Back to live
        </a>
      </p>
    </main>
  );
}
function ReplayList({ client }: { client: AppProps['client'] }) {
  const load = useLoad(() => fetchReplayList(client.baseUrl, client.fetchImpl), 'list');
  return (
    <Page title="Replays">
      {load === null ? <p role="status">Loading the replays.</p> : null}
      {load?.status === 'error' || load?.status === 'missing' ? <p role="alert">The replays cannot be loaded now. Try again later.</p> : null}
      {load?.status === 'ok' && load.value.length === 0 ? (
        <p className="empty-state"><strong>There is no replay yet.</strong> A replay is a recorded incident that you can play back, step by step, like the live page.</p>
      ) : null}
      {load?.status === 'ok' && load.value.length > 0 ? (
        <ul className="replay-list cards">
          {load.value.map((r: ReplayListItem) => (
            <li key={r.id} className="card">
              <a href={`/replays/${r.id}`}>{r.title}</a>
              <span className="pill pill--scenario">{r.scenario}</span>
              <span className="card-meta">
                Recorded on <time dateTime={r.recordedOn}>{r.recordedOn}</time>, <span className="num">{durationText(r.durationMs)}</span> long
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Page>
  );
}
/** The page of one loaded file: the player decides the state, and `App` shows it the way it shows live state. */
function Playback({ file, Shell, ...props }: AppProps & { file: ReplayFile; Shell: ComponentType<AppProps> }) {
  const reducedMotion = usePrefersReducedMotion();
  const mode = useAccessibleMode();
  // Paused at the start when the browser asks for reduced motion or Accessible mode is on; read once.
  const [startPaused] = useState(() => reducedMotion || mode.accessible);
  const [state, dispatch] = useReplayPlayer(file, !startPaused);
  const states = useMemo(() => timeline(file.frames), [file]);
  const shown = stateAt(states, file.frames, state.position);
  // The detail of the finished Hunt is the one of the frame; it never goes to the API.
  const frameHunt = shown.hunt;
  const loadHuntDetail = useMemo(() => (id: string) => (frameHunt !== null && frameHunt.id === id ? Promise.resolve(frameHunt) : Promise.reject(new Error('no detail'))), [frameHunt]);
  const replay = {
    services: shown.services,
    proposal: shown.proposal,
    now: sceneClock(file.recordedOn, state.position),
    banner: bannerText(file.recordedOn),
    loadHuntDetail,
    controls: <ReplayControls file={file} state={state} dispatch={dispatch} />,
  };
  return <Shell {...props} replay={replay} />;
}
function ReplayPage({ id, ...props }: AppProps & { id: string; Shell: ComponentType<AppProps> }) {
  const load = useLoad(() => fetchReplay(props.client.baseUrl, id, props.client.fetchImpl), id);
  if (load === null) return <Page title="Replay"><p role="status">Loading the replay.</p></Page>;
  if (load.status === 'missing') {
    return (
      <Page title="This replay does not exist">
        <p>
          <a href="/replays">See the replays</a>
        </p>
      </Page>
    );
  }
  if (load.status === 'error') return <Page title="Replay"><p role="alert">The replay cannot be loaded now. Try again later.</p></Page>;
  return <Playback {...props} file={load.value} />;
}
/** The replay routes. Loaded with `import()` on `/replays` and `/replays/<id>` only. */
export default function ReplayApp({ route, ...props }: AppProps & { route: ReplayRoute; Shell: ComponentType<AppProps> }) {
  return route.kind === 'list' ? <ReplayList client={props.client} /> : <ReplayPage {...props} id={route.id} />;
}
