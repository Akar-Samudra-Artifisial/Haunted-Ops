# Replays

A replay is one recorded incident of the lab (services going bad, the hunt with its steps and evidence, the fix proposal with its checks, the pull request, the merge and the deploy) as one sanitized JSON file. A person reads it and approves it. Only a reviewed file is seeded into PostgreSQL, served at `GET /api/replays/<id>` and played back at `/replays/<id>`.

This folder holds `<id>.json` files and this README. A file with `"review": null` is never seeded or shipped: `deploy/build-release.sh` refuses it (the release check names it `replay_unreviewed`).

## Build one

Run it on the Mac, against the database that holds the incident. The tool only reads (`find*` calls) and never prints the database URL. The URL comes from the environment variable `DATABASE_URL` only: there is no option for it, because an argument shows in `ps` and in the shell history. Build the packages first (`pnpm build`): the tool uses the validator of `@haunted-ops/shared` and `sanitizePrText` of the API from their `dist` folders, and it stops with `build_stale` when a `dist` folder is older than its sources.

```sh
DATABASE_URL=<url of the database> node tools/replay-build/build-replay.mjs \
  --incident <incident id> \
  --id <replay id> \
  --scenario error-spike|fog|dark-room \
  [--title "<one line, at most 80 characters>"] [--lead-s 60] [--tail-s 30]
```

It writes `fixtures/replays/<replay id>.json` with `review: null` and refuses to replace a file that exists. The replay id matches `^[a-z0-9][a-z0-9-]{2,47}$`. The window runs from `--lead-s` seconds before the incident opened to `--tail-s` seconds after the last event (the incident closing, the hunt ending or the fix deploying), at most 15 minutes. What the tool does to the data:

- Every string goes through the scrubber of `tools/sanitize-replay/sanitize-hunt-stream.mjs` (emails, home and temp paths, tokens, UUIDs, account ids, IP addresses, host names, ANSI escapes), then through `sanitizePrText` (no HTML, markdown link or image, URL, mention or issue reference), then scrubbed again until the text stops changing (removing an invisible character can join a token), with host names, IPv6 addresses, mentions, `/root/` paths and long unbroken runs cut last.
- Ids of the incident, the hunt and the proposal become stable fake ids derived from the replay id. The pull request link becomes `https://github.com/Akar-Samudra-Artifisial/Haunted-Lab/pull/<n>`; the login of who merged becomes `reviewer`. Commit SHAs of the public lab repository stay.
- Times move to the recording date at midnight UTC plus the offset in the incident, so the hour of the real incident is not in the file. `recordedOn` is a date only.
- These never appear: `aiFailDetail`, raw stream lines, file paths of the work folders, credits per tool call (the hunt keeps its total only).
- If the result still fails `validateReplayFile`, the tool stops and names the field paths, never a value.

## Review one

```sh
node tools/replay-build/review-replay.mjs fixtures/replays/<id>.json --by AB --note "Read every string."
```

This prints every string of the file with its path, frame by frame, and changes nothing. Read all of it: look for a name, a host, a path, a key, anything that identifies a person or a machine, and for text you do not want on a public page. Then run the same command with `--approve`. It checks the file again and writes `review: { reviewedOn, by, note, sha256 }` (a date, 2 to 4 letters, at most 200 characters, and the SHA-256 of the file with `review` set to `null` as canonical JSON). The hash binds the review to the content: if you edit the file afterwards, the validator, the release check and the seed refuse it until you run the review again (the tool reads the edited file and writes a new hash).

## Add one

1. Build, review and approve the file as above.
2. `git add fixtures/replays/<id>.json` and commit it. Never commit a file with `review: null`.
3. Locally: `pnpm --filter @haunted-ops/api seed:replays` seeds the reviewed files of this folder into `DATABASE_URL`. It names a skipped (unreviewed) file, stops on an invalid one, keeps rows whose file did not change and deletes rows whose file is gone.
4. On the demo server: `deploy/build-release.sh` ships `fixtures/replays/*.json`; `deploy/server/seed.mjs` seeds them at every install.

The synthetic replay used by the tests lives in `apps/api/test/fixtures/replays/` and is never shipped.
