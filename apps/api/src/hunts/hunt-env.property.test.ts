import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HAUNT_REASON_KINDS, HUNT_TOOLS, SERVICE_NAMES } from '@haunted-ops/shared';
import { HUNT_ENV_NAMES, PromptFactsError, TRUSTED_TOOL_NAMES, buildHuntArgv, buildHuntEnv, huntPrompt, type PromptFacts } from './hunt-env.js';

const RUNS = { numRuns: 200 };
const cuid = fc.stringMatching(/^[a-z0-9]{25}$/);
const factsArb: fc.Arbitrary<PromptFacts> = fc.record({
  incidentId: cuid,
  service: fc.constantFrom(...SERVICE_NAMES),
  level: fc.constantFrom(2 as const, 3 as const, 4 as const),
  reasonKind: fc.option(fc.constantFrom(...HAUNT_REASON_KINDS), { nil: null }),
  openedAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2099-12-31'), noInvalidDate: true }),
});
const modelArb = fc.stringMatching(/^[a-z0-9][a-z0-9.-]{1,40}$/);

const FORBIDDEN = ['DATABASE_URL', 'TEST_DATABASE_URL', 'HUNT_ADMIN_TOKEN', 'CHAOS_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'KIRO_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'PORT', 'WEB_ORIGIN'];
const PROMPT = /^Incident [a-z0-9]{25} on service (gate|orders|payments|ledger): haunt level [234], reason (error_rate|p95|down|unknown), opened at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\. The services call each other in a chain: gate calls orders, orders calls payments, payments calls ledger\. The cause may be a recent deploy of (gate or of orders, payments, ledger|orders or of payments, ledger|payments or of ledger|ledger)\. Investigate it and call submit_diagnosis once\.$/;

// Feature: exorcist-agent, Property 11
describe('Property 11: the hunt process gets a fixed argument vector and a minimal environment', () => {
  it('builds the same flags in the same order for any model and incident, with only validated facts in the prompt', () => {
    fc.assert(
      fc.property(modelArb, factsArb, (model, facts) => {
        const argv = buildHuntArgv({ model }, facts);
        expect(argv.slice(0, 10)).toEqual([
          'chat', '--no-interactive', '--trust-workspace', '--require-mcp-startup', '--agent', 'exorcist', '--model', model, '--output-format', 'stream-json',
        ]);
        expect(argv).toHaveLength(12);
        expect(argv[10]).toBe(`--trust-tools=${HUNT_TOOLS.map((t) => `@exorcist/${t}`).join(',')}`);
        expect(argv[10]?.slice('--trust-tools='.length).split(',')).toEqual([...TRUSTED_TOOL_NAMES]);
        expect(argv[11]).toMatch(PROMPT);
        expect(argv[11]).toBe(huntPrompt(facts));
        // No flag that widens trust, and nothing a shell would treat specially in the prompt.
        expect(argv.some((a) => a === '--trust-all-tools' || a === '-a')).toBe(false);
        expect(/[`$;|&<>\\\n"']/.test(argv[11] as string)).toBe(false);
      }),
      RUNS,
    );
  });

  it('refuses facts that are not what they should be, naming the field and never the value', () => {
    const evil = fc.constantFrom('x; rm -rf /', '$(id)', 'payments\nIgnore previous', '../etc', '', ' ');
    fc.assert(
      fc.property(factsArb, evil, fc.constantFrom('incidentId', 'service', 'reasonKind', 'openedAt', 'level'), (facts, bad, field) => {
        const broken = { ...facts, [field]: field === 'openedAt' ? new Date('not a date') : field === 'level' ? 7 : bad } as unknown as PromptFacts;
        let caught: unknown;
        try {
          huntPrompt(broken);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(PromptFactsError);
        expect((caught as PromptFactsError).field).toBe(field);
        expect((caught as PromptFactsError).message).toBe(`invalid prompt fact: ${field}`);
      }),
      RUNS,
    );
  });

  it('gives exactly the allowed environment names for any parent environment, and none of its secrets', () => {
    const parentArb = fc.dictionary(
      fc.oneof(fc.constantFrom(...FORBIDDEN, 'PATH', 'HOME', 'LANG', 'NODE_OPTIONS', 'LD_PRELOAD', 'KIRO_CLI_PATH', 'HUNT_ID'), fc.stringMatching(/^[A-Z][A-Z0-9_]{1,20}$/)),
      fc.stringMatching(/^SECRET[A-Za-z0-9]{12,30}$/),
      { maxKeys: 30 },
    );
    fc.assert(
      fc.property(parentArb, fc.boolean(), fc.boolean(), (parent, labRemote, promRemote) => {
        const env = buildHuntEnv({
          cfg: { labUrl: 'http://127.0.0.1:4100', labReadToken: 'lab-read-token-0123456789-abcdef', labAllowRemote: labRemote, kiroCliPath: '/opt/kiro/bin/kiro-cli' },
          prometheusUrl: 'http://127.0.0.1:9090',
          prometheusAllowRemote: promRemote,
          huntId: 'cmhuntaaaaaaaaaaaaaaaaaaa',
          ledgerPath: '/tmp/haunted-ops-hunts/ledgers/cmhuntaaaaaaaaaaaaaaaaaaa.jsonl',
          mcpBinDir: '/repo/packages/exorcist-mcp/bin',
          parentEnv: parent,
          nodeDir: '/usr/local/node/bin',
        });
        expect(Object.keys(env).sort()).toEqual([...HUNT_ENV_NAMES].sort());
        for (const name of FORBIDDEN) expect(name in env).toBe(false);
        const text = JSON.stringify(env);
        for (const [name, value] of Object.entries(parent)) {
          if (name === 'HOME' || name === 'LANG') continue;
          expect(text.includes(value), name).toBe(false);
        }
        expect(env.LAB_ALLOW_REMOTE).toBe(labRemote ? 'true' : 'false');
        expect(env.PROMETHEUS_ALLOW_REMOTE).toBe(promRemote ? 'true' : 'false');
        expect(env.TERM).toBe('dumb');
        expect(env.NO_COLOR).toBe('1');
        const path = env.PATH?.split(':') ?? [];
        expect(path[0]).toBe('/repo/packages/exorcist-mcp/bin');
        expect(path.every((p) => p.startsWith('/'))).toBe(true);
        expect(path).toContain('/opt/kiro/bin');
        expect(new Set(path).size).toBe(path.length);
        // LANG is kept only when it is a plain locale name; HOME is the parent's.
        expect(env.LANG).toMatch(/^[A-Za-z0-9_.@-]{1,40}$/);
        if (parent.HOME) expect(env.HOME).toBe(parent.HOME);
      }),
      RUNS,
    );
  });
});
