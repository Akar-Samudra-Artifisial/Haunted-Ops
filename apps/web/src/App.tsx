import { useEffect, useState } from 'react';
import type { IngestStatus, ServiceState } from '@haunted-ops/shared';
import { Header } from './components/Header.js';
import { LiveAnnouncer } from './components/LiveAnnouncer.js';
import { SceneMount } from './components/SceneMount.js';
import { TableMode } from './components/TableMode.js';
import { SseClient, type SseClientOptions } from './net/sse-client.js';
import type { ConnectionStatus } from './net/status.js';

export type ClientOptions = Omit<SseClientOptions, 'onServices' | 'onConnection' | 'onIngest'>;

/** Keeps Service state and connection status in sync with the API. */
export function useLiveServices(options: ClientOptions): { services: ServiceState[]; status: ConnectionStatus; ingest: IngestStatus | null } {
  const [services, setServices] = useState<ServiceState[]>([]);
  const [ingest, setIngest] = useState<IngestStatus | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('reconnecting');

  useEffect(() => {
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

export function App({ client }: { client: ClientOptions }) {
  const { services, status, ingest } = useLiveServices(client);
  return (
    <div className="app">
      <Header status={status} />
      <main className="app-main">
        <SceneMount />
        <TableMode services={services} ingest={ingest} />
        <LiveAnnouncer services={services} />
      </main>
    </div>
  );
}
