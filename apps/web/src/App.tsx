import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { focusIsFreeOrIn, focusRow } from './a11y/focus.js';
import { useAccessibleMode } from './a11y/useAccessibleMode.js';
import type { IngestStatus, ServiceName, ServiceState } from '@haunted-ops/shared';
import { Header } from './components/Header.js';
import { LiveAnnouncer, type Notice } from './components/LiveAnnouncer.js';
import { SkipLink } from './components/SkipLink.js';
import { SceneMount, type SceneMountProps } from './components/SceneMount.js';
import { TableMode } from './components/TableMode.js';
import { fetchHuntDetail } from './net/api.js';
import { SseClient, type SseClientOptions } from './net/sse-client.js';
import type { ConnectionStatus } from './net/status.js';
import type { Quality } from './scene/governor.js';
import { usePrefersReducedMotion, useNow } from './scene/hooks.js';
import { toSceneModel } from './scene/model.js';
import type { DemoMode } from './scene/params.js';
import { statusMark } from './a11y/status-marks.js';
import { selectionReducer } from './scene/selection.js';
import { useDemoServices } from './scene/source.js';

export type ClientOptions = Omit<SseClientOptions, 'onServices' | 'onConnection' | 'onIngest'>;

/** Keeps Service state and connection status in sync with the API. */
export function useLiveServices(options: ClientOptions, enabled = true): { services: ServiceState[]; status: ConnectionStatus; ingest: IngestStatus | null } {
  const [services, setServices] = useState<ServiceState[]>([]);
  const [ingest, setIngest] = useState<IngestStatus | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('reconnecting');
  useEffect(() => {
    // Demo mode makes no request to the API or the stream.
    if (!enabled) return;
    const client = new SseClient({
      ...options,
      onServices: (next) => setServices([...next]),
      onIngest: (next) => setIngest(next),
      onConnection: (state) => setStatus(state.status),
    });
    client.start();
    return () => client.stop();
    // The client is created once per mount; options are fixed for the app lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { services, status, ingest };
}

/** The Hunt id of a `/hunts/<id>` link (the link a pull request carries), or null for any other path. */
export function huntIdFromPath(pathname: string): string | null {
  const m = /^\/hunts\/([a-z0-9]{20,32})\/?$/.exec(pathname);
  return m === null ? null : (m[1] as string);
}

/** What the scene mount needs besides data; tests and Demo mode can replace the loader or the renderer. */
export type SceneOptions = Pick<SceneMountProps, 'loadCanvas' | 'createRenderer'>;

export function App({ client, demo = null, scene = {} }: { client: ClientOptions; demo?: DemoMode; scene?: SceneOptions }) {
  const live = useLiveServices(client, demo === null);
  const demoServices = useDemoServices(demo);
  const services = demo === null ? live.services : demoServices;
  const status = live.status;
  const ingest = demo === null ? live.ingest : null;

  const reducedMotion = usePrefersReducedMotion();
  // The wall clock needs a minute; a Hunt that runs or ended lately needs seconds (the walk in and the 8 s the figure stays).
  const minute = useNow(60_000);
  const huntBusy = services.some((s) => s.hunt !== null && (s.hunt.finishedAt === null || minute - Date.parse(s.hunt.finishedAt) < 60_000));
  const second = useNow(huntBusy ? 1000 : 60_000);
  const now = huntBusy ? second : minute;
  const [quality, setQuality] = useState<Quality>('full');
  const [selected, dispatch] = useReducer(selectionReducer, null);
  const mode = useAccessibleMode();
  const accessible = mode.accessible;
  // No Scene model in Accessible mode: the Scene is not mounted.
  const model = useMemo(() => (accessible ? null : toSceneModel(services, now, { reducedMotion, quality })), [accessible, services, now, reducedMotion, quality]);
  const focusRequest = useRef<ServiceName | null>(null);
  // Changes a screen-reader user needs, said through the one announcer; the first state is silent.
  const [notice, setNotice] = useState<Notice | null>(null);
  const say = useCallback((text: string) => setNotice({ text }), []);
  // null until the first ingest status arrives; that first state is not a change.
  const stale = ingest === null ? null : ingest.state === 'stale';
  const lastNotified = useRef({ status, stale, connected: status === 'live' });
  useEffect(() => {
    const last = lastNotified.current;
    if (demo !== null) return;
    if (status !== last.status) {
      if (status !== 'live' || last.connected) say(`Connection: ${statusMark('connection', status).label}.`);
      last.connected ||= status === 'live';
      last.status = status;
    }
    if (stale !== last.stale) {
      if (last.stale !== null && stale !== null) say(stale ? 'Metrics are stale.' : 'Metrics are fresh again.');
      last.stale = stale;
    }
  }, [status, stale, demo, say]);
  useEffect(() => {
    // The marker the stylesheet uses to stop all motion, also when the browser does not report Reduced motion.
    const root = document.documentElement;
    if (accessible) root.dataset['a11y'] = 'on';
    else delete root.dataset['a11y'];
    return () => {
      delete root.dataset['a11y'];
    };
  }, [accessible]);

  // The detail of a finished Hunt (its cited evidence) comes from the API; Demo mode has none.
  const loadHuntDetail = useMemo(
    () => (demo === null ? (id: string) => fetchHuntDetail(client.baseUrl, id, client.fetchImpl) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo],
  );
  const select = (name: ServiceName | null): void => dispatch(name === null ? { type: 'clear' } : { type: 'select', name });
  useEffect(() => {
    // A `/hunts/<id>` link opens on that Hunt's Service. The path is read once, at start.
    const huntId = demo === null ? huntIdFromPath(window.location.pathname) : null;
    if (huntId === null) return;
    let live = true;
    fetchHuntDetail(client.baseUrl, huntId, client.fetchImpl).then(
      (detail) => {
        if (!live) return;
        dispatch({ type: 'select', name: detail.service });
        focusRequest.current = detail.service;
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Escape clears the selection in the scene and in the table.
    if (selected === null) return;
    const opener = selected;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // Focus goes back to the row that opened the detail, unless it is on something else (a room button).
      const back = focusIsFreeOrIn(document.getElementById('services'));
      dispatch({ type: 'clear' });
      if (back) focusRow(opener);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected]);

  useEffect(() => {
    // A deep link in Accessible mode puts focus on the row of its Service once the row exists.
    if (focusRequest.current === null) return;
    // Scene mode cannot use the request; it is dropped so that a later switch does not take focus.
    if (!accessible) {
      focusRequest.current = null;
      return;
    }
    if (focusRow(focusRequest.current)) focusRequest.current = null;
  }, [accessible, services, selected]);
  return (
    <div className="app">
      <SkipLink />
      <Header status={status} demo={demo !== null} accessible={{ on: accessible, onToggle: mode.toggle }} />
      <main className="app-main">
        {model === null ? null : (
          <SceneMount
            services={services}
            model={model}
            selected={selected}
            onSelect={select}
            onQuality={setQuality}
            publishStats={demo !== null}
            onNotice={say}
            {...scene}
          />
        )}
        <TableMode services={services} ingest={ingest} selected={selected} onSelect={select} loadHuntDetail={loadHuntDetail} />
        <LiveAnnouncer services={services} notice={notice} />
      </main>
    </div>
  );
}
