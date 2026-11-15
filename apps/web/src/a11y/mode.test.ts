import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { STORAGE_KEY, parseModeParam, parseSavedChoice, resolveMode, serializeChoice, type ModeInput, type SavedChoice, type UrlMode } from './mode.js';
import { readSavedChoice, writeSavedChoice, type StorageLike } from './storage.js';

const input = (over: Partial<ModeInput> = {}): ModeInput => ({ urlMode: null, saved: null, reducedMotion: false, ...over });

function memory(initial: string | null = null): StorageLike & { value: string | null } {
  const store = {
    value: initial,
    getItem: (key: string) => (key === STORAGE_KEY ? store.value : null),
    setItem: (key: string, v: string) => {
      if (key === STORAGE_KEY) store.value = v;
    },
  };
  return store;
}

describe('resolveMode', () => {
  it('is off with no input', () => {
    expect(resolveMode(input())).toEqual({ accessible: false, source: 'default' });
  });
  it('turns on with Reduced motion and no choice', () => {
    expect(resolveMode(input({ reducedMotion: true }))).toEqual({ accessible: true, source: 'reduced-motion' });
  });
  it('lets a saved off beat Reduced motion, and a saved on beat nothing', () => {
    expect(resolveMode(input({ saved: 'off', reducedMotion: true }))).toEqual({ accessible: false, source: 'saved' });
    expect(resolveMode(input({ saved: 'on' }))).toEqual({ accessible: true, source: 'saved' });
  });
  it('lets the URL beat the saved choice and Reduced motion', () => {
    expect(resolveMode(input({ urlMode: 'accessible', saved: 'off' }))).toEqual({ accessible: true, source: 'url-accessible' });
    expect(resolveMode(input({ urlMode: 'scene', saved: 'on', reducedMotion: true }))).toEqual({ accessible: false, source: 'url-scene' });
  });
});

describe('parseModeParam', () => {
  it('accepts only the two exact words and takes the first value', () => {
    expect(parseModeParam('?mode=accessible')).toBe('accessible');
    expect(parseModeParam('?demo=1&mode=scene')).toBe('scene');
    expect(parseModeParam('?mode=Accessible')).toBeNull();
    expect(parseModeParam('?mode=')).toBeNull();
    expect(parseModeParam('')).toBeNull();
    expect(parseModeParam('?mode=scene&mode=accessible')).toBe('scene');
  });
});

describe('the saved choice', () => {
  it('reads what it wrote', () => {
    const store = memory();
    expect(writeSavedChoice('on', store)).toBe(true);
    expect(store.value).toBe('{"mode":"on"}');
    expect(readSavedChoice(store)).toBe('on');
    writeSavedChoice('off', store);
    expect(readSavedChoice(store)).toBe('off');
    expect(parseSavedChoice(serializeChoice('on'))).toBe('on');
  });
  it('treats bad JSON, wrong shapes and unknown values as no choice', () => {
    for (const raw of [null, '', '{', 'on', '"on"', '[]', 'null', '{"mode":"yes"}', '{"mode":1}', '{"other":"on"}', '["on"]']) {
      expect(parseSavedChoice(raw)).toBeNull();
    }
  });
  it('treats missing, blocked and throwing storage as no choice and fails a write quietly', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(readSavedChoice(null)).toBeNull();
    expect(readSavedChoice(throwing)).toBeNull();
    expect(writeSavedChoice('on', throwing)).toBe(false);
    expect(writeSavedChoice('on', null)).toBe(false);
  });
  it('treats a localStorage getter that throws as no choice', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    try {
      expect(readSavedChoice()).toBeNull();
      expect(writeSavedChoice('on')).toBe(false);
    } finally {
      if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    }
  });
});

describe('Property 1: mode resolution follows the precedence', () => {
  // Feature: accessible-mode, Property 1
  it('returns the first rule that applies and names it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<UrlMode>(null, 'scene', 'accessible'),
        fc.constantFrom<SavedChoice>(null, 'on', 'off'),
        fc.boolean(),
        (urlMode, saved, reducedMotion) => {
          const r = resolveMode({ urlMode, saved, reducedMotion });
          if (urlMode === 'scene') expect(r).toEqual({ accessible: false, source: 'url-scene' });
          else if (urlMode === 'accessible') expect(r).toEqual({ accessible: true, source: 'url-accessible' });
          else if (saved !== null) expect(r).toEqual({ accessible: saved === 'on', source: 'saved' });
          else if (reducedMotion) expect(r).toEqual({ accessible: true, source: 'reduced-motion' });
          else expect(r).toEqual({ accessible: false, source: 'default' });
          expect(resolveMode({ urlMode, saved, reducedMotion })).toEqual(r);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property 2: reading the saved choice never throws', () => {
  // Feature: accessible-mode, Property 2
  it('gives on, off or null for any text, and any throwing storage', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.constant(null), fc.json()), (raw) => {
        expect([null, 'on', 'off']).toContain(parseSavedChoice(raw));
        expect([null, 'on', 'off']).toContain(readSavedChoice({ getItem: () => raw, setItem: () => undefined }));
      }),
      { numRuns: 150 },
    );
    fc.assert(
      fc.property(fc.constantFrom<'on' | 'off'>('on', 'off'), fc.boolean(), (choice, throws) => {
        const store = memory();
        const bad: StorageLike = {
          getItem: () => {
            throw new Error('x');
          },
          setItem: () => {
            throw new Error('x');
          },
        };
        expect(() => readSavedChoice(throws ? bad : store)).not.toThrow();
        expect(() => writeSavedChoice(choice, throws ? bad : store)).not.toThrow();
        if (!throws) expect(readSavedChoice(store)).toBe(choice);
      }),
      { numRuns: 100 },
    );
  });
});
