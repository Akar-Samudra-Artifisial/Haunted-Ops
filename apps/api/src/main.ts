import { createApp } from './app.js';
import { loadConfigOrExit } from './config/load.js';
import { FixConfigError, loadFixConfigOrExit } from './fix/fix-config.js';
import { checkFixStartup } from './fix/fix-startup.js';
import { FixerWorkdirError } from './fix/fixer-workdir.js';
import { GitClient } from './fix/git-client.js';
import { GithubClient } from './fix/github-client.js';
import { ProposalRunner } from './fix/proposal-runner.js';
import { HuntConfigError, loadHuntConfigOrExit } from './hunts/hunt-config.js';
import { HuntRunner } from './hunts/hunt-runner.js';
import { WorkdirError } from './hunts/hunt-workdir.js';
import { IngestRunner } from './ingest/ingest.runner.js';
import { JsonLogger } from './security/logger.js';

// Config is validated before the app is created; on failure the process exits 1 and nothing listens.
const config = loadConfigOrExit();
const huntConfig = loadHuntConfigOrExit();
const fixConfig = loadFixConfigOrExit(huntConfig);
const app = await createApp(config, { huntConfig, fixConfig });
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
// The fix flow: with FIX_ENABLED=true the token, the repository and git are checked once, then the runner starts.
// It reaps fixer processes a crash left behind, ends the Proposals that were drafting, and watches the open ones.
try {
  const logger = new JsonLogger();
  await checkFixStartup(fixConfig, {
    github: app.get(GithubClient),
    gitVersion: () => app.get(GitClient).version(),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  await app.get(ProposalRunner).start();
} catch (err) {
  // A bad token, repository or folder is a setting problem: name the variable, never the value or the path.
  if (err instanceof FixConfigError || err instanceof FixerWorkdirError) {
    process.stderr.write(`${err instanceof FixConfigError ? err.message : new FixConfigError(['FIX_WORKDIR']).message}\n`);
    await app.close();
    process.exit(1);
  }
  throw err;
}
