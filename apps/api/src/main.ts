import { createApp } from './app.js';
import { loadConfigOrExit } from './config/load.js';
import { HuntConfigError, loadHuntConfigOrExit } from './hunts/hunt-config.js';
import { HuntRunner } from './hunts/hunt-runner.js';
import { WorkdirError } from './hunts/hunt-workdir.js';
import { IngestRunner } from './ingest/ingest.runner.js';

// Config is validated before the app is created; on failure the process exits 1 and nothing listens.
const config = loadConfigOrExit();
const huntConfig = loadHuntConfigOrExit();
const app = await createApp(config, { huntConfig });
// HOST defaults to 127.0.0.1; production sets it explicitly (for example 0.0.0.0 behind a proxy).
await app.listen(config.port, config.host);
// Polling starts once the server listens; it stops with the app (IngestRunner.onModuleDestroy).
app.get(IngestRunner).start();
// Hunts: the runner sweeps leftovers, prepares its folder and listens for Incidents. It stops with the app.
try {
  await app.get(HuntRunner).start();
} catch (err) {
  // A refused working folder is a setting problem: name the variable, never the path.
  if (err instanceof WorkdirError) {
    process.stderr.write(`${new HuntConfigError(['HUNT_WORKDIR']).message}\n`);
    await app.close();
    process.exit(1);
  }
  throw err;
}
