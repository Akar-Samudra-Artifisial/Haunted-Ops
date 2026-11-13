import { useEffect, useMemo, useReducer, useState } from 'react';
import type { IngestStatus, ServiceName, ServiceState } from '@haunted-ops/shared';
import { Header } from './components/Header.js';
import { LiveAnnouncer } from './components/LiveAnnouncer.js';
import { SceneMount, type SceneMountProps } from './components/SceneMount.js';
import { TableMode } from './components/TableMode.js';
import { fetchHuntDetail } from './net/api.js';
import { SseClient, type SseClientOptions } from './net/sse-client.js';
import type { ConnectionStatus } from './net/status.js';
import type { Quality } from './scene/governor.js';
import { usePrefersReducedMotion, useNow } from './scene/hooks.js';
import { toSceneModel } from './scene/model.js';
import type { DemoMode } from './scene/params.js';
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
  const model = useMemo(() => toSceneModel(services, now, { reducedMotion, quality }), [services, now, reducedMotion, quality]);

  // The detail of a finished Hunt (its cited evidence) comes from the API; Demo mode has none.
  const loadHuntDetail = useMemo(
    () => (demo === null ? (id: string) => fetchHuntDetail(client.baseUrl, id, client.fetchImpl) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo],
  );
  const select = (name: ServiceName | null): void => dispatch(name === null ? { type: 'clear' } : { type: 'select', name });
  useEffect(() => {
    // Escape clears the selection in the scene and in the table.
    if (selected === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dispatch({ type: 'clear' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected]);

  return (
    <div className="app">
      <Header status={status} demo={demo !== null} />
      <main className="app-main">
        <SceneMount
          services={services}
          model={model}
          selected={selected}
          onSelect={select}
          onQuality={setQuality}
          publishStats={demo !== null}
          {...scene}
        />
        <TableMode services={services} ingest={ingest} selected={selected} onSelect={select} loadHuntDetail={loadHuntDetail} />
        <LiveAnnouncer services={services} />
      </main>
    </div>
  );
}
