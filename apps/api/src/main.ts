import { createApp } from './app.js';
import { loadConfigOrExit } from './config/load.js';
import { IngestRunner } from './ingest/ingest.runner.js';

// Config is validated before the app is created; on failure the process exits 1 and nothing listens.
const config = loadConfigOrExit();
const app = await createApp(config);
// HOST defaults to 127.0.0.1; production sets it explicitly (for example 0.0.0.0 behind a proxy).
await app.listen(config.port, config.host);
// Polling starts once the server listens; it stops with the app (IngestRunner.onModuleDestroy).
app.get(IngestRunner).start();
