import { useEffect, useState } from 'react';
import type { ServiceState } from '@haunted-ops/shared';
import { Header } from './components/Header.js';
import { SceneMount } from './components/SceneMount.js';
import { TableMode } from './components/TableMode.js';
import { SseClient, type SseClientOptions } from './net/sse-client.js';
import type { ConnectionStatus } from './net/status.js';

export type ClientOptions = Omit<SseClientOptions, 'onServices' | 'onConnection'>;

/** Keeps Service state and connection status in sync with the API. */
export function useLiveServices(options: ClientOptions): { services: ServiceState[]; status: ConnectionStatus } {
  const [services, setServices] = useState<ServiceState[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>('reconnecting');

  useEffect(() => {
    const client = new SseClient({
      ...options,
      onServices: (next) => setServices([...next]),
      onConnection: (state) => setStatus(state.status),
    });
    client.start();
    return () => client.stop();
    // The client is created once per mount; options are fixed for the app lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { services, status };
}

export function App({ client }: { client: ClientOptions }) {
  const { services, status } = useLiveServices(client);
  return (
    <div className="app">
      <Header status={status} />
      <main className="app-main">
        <SceneMount />
        <TableMode services={services} />
      </main>
    </div>
  );
}
