import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceState } from '@haunted-ops/shared';
import { Header } from '../components/Header.js';
import { SoundButton } from '../components/SoundButton.js';
import { makeService } from '../test/arbs.js';
import { SOUND_KEY, readSoundOn, writeSoundOn } from './storage.js';
import { CUE_FILES, MASTER_GAIN, createPlayer, type SoundPlayer } from './player.js';
import { CONFIRM_GAIN, SILENCE_HINT_MS, makeContext, useSound, type LoadPlayer, type MakeContext } from './useSound.js';

const fakeContext = () => ({ resume: vi.fn(async () => undefined), close: vi.fn(async () => undefined), state: 'running' }) as unknown as AudioContext;
const defaultMakeContext: MakeContext = () => fakeContext();
function Harness({ services, loadPlayer, enabled = true, makeContext: make = defaultMakeContext }: { services: ServiceState[]; loadPlayer: LoadPlayer; enabled?: boolean; makeContext?: MakeContext }) {
  const sound = useSound(services, { loadPlayer, enabled, makeContext: make });
  return <SoundButton on={sound.on} unavailable={sound.unavailable} hint={sound.hint} onToggle={sound.toggle} />;
}

const fakePlayer = () => ({
  play: vi.fn<(cue: string, gain?: number) => void>(),
  resume: vi.fn(async () => undefined),
  state: vi.fn<() => AudioContextState>(() => 'running'),
  close: vi.fn<() => void>(),
});
const loaderOf = (player: SoundPlayer | ReturnType<typeof fakePlayer>): LoadPlayer => vi.fn(async () => ({ createPlayer: async () => player as SoundPlayer }));

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the sound button', () => {
  it('is off by default: "Sound off", not pressed, a real button with an icon', () => {
    render(<Harness services={[]} loadPlayer={loaderOf(fakePlayer())} />);
    const button = screen.getByRole('button', { name: 'Sound off' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.tagName).toBe('BUTTON');
    expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it('turns on with a click: "Sound on", pressed, and the choice is stored under haunted-ops.sound.v1', () => {
    render(<Harness services={[]} loadPlayer={loaderOf(fakePlayer())} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    const button = screen.getByRole('button', { name: 'Sound on' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(localStorage.getItem('haunted-ops.sound.v1') as string)).toEqual({ sound: 'on' });
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Sound off' }).getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(localStorage.getItem(SOUND_KEY) as string)).toEqual({ sound: 'off' });
  });

  it('is keyboard operable: it is a button that Enter and Space activate (a native one), reachable by Tab', () => {
    render(<Harness services={[]} loadPlayer={loaderOf(fakePlayer())} />);
    const button = screen.getByRole('button', { name: 'Sound off' });
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('type')).toBe('button');
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('comes after the Accessible mode switch in the header, which stays the first control', () => {
    render(<Header status="live" accessible={{ on: false, onToggle: () => undefined }} sound={{ on: false, unavailable: false, onToggle: () => undefined }} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['○ Accessible mode', 'Sound off']);
  });

  it('shows no sound button where none is given (the replay page)', () => {
    render(<Header status="live" accessible={{ on: false, onToggle: () => undefined }} />);
    expect(screen.queryByRole('button', { name: /sound/i })).toBeNull();
  });

  it('says "Sound unavailable" and stays clickable (a click tries again) when the sound cannot work', () => {
    const onToggle = vi.fn();
    render(<SoundButton on unavailable onToggle={onToggle} />);
    const button = screen.getByRole('button', { name: 'Sound unavailable' });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('the stored choice', () => {
  it('reads only {"sound":"on"} as on, and every bad value as off', () => {
    const store = (raw: string | null) => ({ getItem: () => raw, setItem: () => undefined });
    expect(readSoundOn(store('{"sound":"on"}'))).toBe(true);
    for (const raw of [null, '', 'on', '{"sound":"off"}', '{"sound":true}', '[]', 'null', '{']) expect(readSoundOn(store(raw))).toBe(false);
    expect(readSoundOn(null)).toBe(false);
    expect(readSoundOn({ getItem: () => { throw new Error('blocked'); }, setItem: () => undefined })).toBe(false);
    expect(writeSoundOn(true, { getItem: () => null, setItem: () => { throw new Error('blocked'); } })).toBe(false);
  });

  it('shows "Sound on" for a stored on, but loads nothing until the first click anywhere on the page', async () => {
    writeSoundOn(true);
    const player = fakePlayer();
    const load = loaderOf(player);
    render(<Harness services={[]} loadPlayer={load} />);
    expect(screen.getByRole('button', { name: 'Sound on' }).getAttribute('aria-pressed')).toBe('true');
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(document.body);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });
});

describe('the start and the wake-up listeners', () => {
  it('does not start on a Tab key press, and starts on a pointerdown (a stored on)', async () => {
    writeSoundOn(true);
    const load = loaderOf(fakePlayer());
    render(<Harness services={[]} loadPlayer={load} />);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    fireEvent.keyDown(document.body, { key: 'a' });
    expect(load).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });

  it('starts on Enter or Space', async () => {
    writeSoundOn(true);
    const load = loaderOf(fakePlayer());
    render(<Harness services={[]} loadPlayer={load} />);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });

  it('with a ready but suspended player, the next click calls resume(); the listeners are gone once it runs', async () => {
    const player = fakePlayer();
    let state: AudioContextState = 'suspended';
    player.state.mockImplementation(() => state);
    player.resume.mockImplementation(async () => {
      state = 'running';
    });
    const load = loaderOf(player);
    render(<Harness services={[]} loadPlayer={load} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    await waitFor(() => expect(load).toHaveBeenCalled());
    for (let i = 0; i < 5; i++) await act(async () => undefined);
    player.resume.mockClear();
    state = 'suspended';
    // The player is ready and suspended: a click on the page wakes it.
    await act(async () => {
      fireEvent.pointerDown(document.body);
    });
    await waitFor(() => expect(player.resume).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    fireEvent.click(document.body);
    fireEvent.pointerDown(document.body);
    expect(player.resume).toHaveBeenCalledTimes(1);
  });

  it('removes the wake-up listeners when sound is turned off and when the component unmounts', async () => {
    const player = fakePlayer();
    player.state.mockImplementation(() => 'suspended');
    const load = loaderOf(player);
    const { unmount } = render(<Harness services={[]} loadPlayer={load} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    await waitFor(() => expect(load).toHaveBeenCalled());
    for (let i = 0; i < 5; i++) await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Sound on' }));
    player.resume.mockClear();
    fireEvent.click(document.body);
    fireEvent.pointerDown(document.body);
    expect(player.resume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    player.resume.mockClear();
    unmount();
    fireEvent.click(document.body);
    fireEvent.pointerDown(document.body);
    expect(player.resume).not.toHaveBeenCalled();
  });
});

describe('the lazy player', () => {
  it('is not imported before the click, once after it, and not again on a second click', async () => {
    const load = loaderOf(fakePlayer());
    render(<Harness services={[]} loadPlayer={load} />);
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Sound on' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('plays a cue for a change after sound is on, and none for a change while it is off', async () => {
    const player = fakePlayer();
    const load = loaderOf(player);
    const calm = [makeService('payments', { hauntLevel: 0 })];
    const haunted = [makeService('payments', { hauntLevel: 2 })];
    const dark = [makeService('payments', { hauntLevel: 4 })];
    const { rerender } = render(<Harness services={calm} loadPlayer={load} />);
    // Off: the change is not played (and the player is not even loaded).
    rerender(<Harness services={haunted} loadPlayer={load} />);
    expect(player.play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    await waitFor(() => expect(load).toHaveBeenCalled());
    for (let i = 0; i < 5; i++) await act(async () => undefined);
    rerender(<Harness services={dark} loadPlayer={load} />);
    expect(player.play).toHaveBeenCalledWith('room-dark');
  });

  it('plays nothing for the first snapshot, even with sound on, and nothing on the replay page (enabled false)', async () => {
    writeSoundOn(true);
    const player = fakePlayer();
    const load = loaderOf(player);
    render(<Harness services={[makeService('payments', { hauntLevel: 3 })]} loadPlayer={load} />);
    fireEvent.click(document.body);
    await waitFor(() => expect(load).toHaveBeenCalled());
    await act(async () => undefined);
    expect(player.play).not.toHaveBeenCalled();
    cleanup();
    const other = fakePlayer();
    const { rerender: again } = render(<Harness services={[makeService('payments', { hauntLevel: 0 })]} loadPlayer={loaderOf(other)} enabled={false} />);
    again(<Harness services={[makeService('payments', { hauntLevel: 4 })]} loadPlayer={loaderOf(other)} enabled={false} />);
    expect(other.play).not.toHaveBeenCalled();
  });

  it('leaves the app working when the chunk or the player fails: the button says unavailable', async () => {
    const failing: LoadPlayer = vi.fn(async () => {
      throw new Error('chunk');
    });
    const { unmount } = render(<Harness services={[]} loadPlayer={failing} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sound unavailable' })).toBeTruthy());
    unmount();
    localStorage.clear();
    const noContext: LoadPlayer = vi.fn(async () => ({
      createPlayer: async () => {
        throw new Error('no audio');
      },
    }));
    render(<Harness services={[]} loadPlayer={noContext} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sound unavailable' })).toBeTruthy());
  });
});

describe('createPlayer', () => {
  class FakeContext {
    static made = 0;
    state = 'running';
    destination = {};
    gain = { value: 1 };
    started: unknown[] = [];
    constructor() {
      FakeContext.made += 1;
      this.state = FakeContext.startState;
    }
    createGain() {
      return { gain: this.gain, connect: vi.fn() };
    }
    createBufferSource() {
      const source = { buffer: null as unknown, connect: vi.fn(), start: vi.fn() };
      this.started.push(source);
      return source;
    }
    async decodeAudioData(data: ArrayBuffer) {
      return { length: data.byteLength };
    }
    static order: string[] = [];
    static startState = 'running';
    async resume() {
      FakeContext.order.push('resume');
      this.state = 'running';
    }
    async close() {
      this.state = 'closed';
    }
  }

  it('fetches the eight same-origin files once, decodes them, sets the master gain to 0.6 and plays a cached buffer', async () => {
    FakeContext.made = 0;
    const asked: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      asked.push(url);
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Response;
    });
    const player = await createPlayer(new FakeContext() as never, { fetch: fetchImpl as never });
    expect(asked.sort()).toEqual(Object.values(CUE_FILES).sort());
    for (const url of asked) expect(url).toMatch(/^\/sfx\/[a-z-]+\.mp3$/);
    expect(MASTER_GAIN).toBe(0.6);
    player.play('hunt-step');
    player.play('hunt-step');
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(FakeContext.made).toBe(1);
    player.close();
  });

  it('resumes once the files are decoded (the caller resumed it in the click), plays only while running and never queues a cue for later', async () => {
    FakeContext.order = [];
    class Suspended extends FakeContext {
      override async resume() {
        FakeContext.order.push('resume');
        // The browser refuses at first: the context stays suspended until `resume` is called again.
        if (FakeContext.order.filter((o) => o === 'resume').length >= 2) this.state = 'running';
      }
    }
    const made: Suspended[] = [];
    class Made extends Suspended {
      constructor() {
        super();
        this.state = 'suspended';
        made.push(this);
      }
    }
    const fetchImpl = vi.fn(async () => {
      FakeContext.order.push('fetch');
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Response;
    });
    const player = await createPlayer(new Made() as never, { fetch: fetchImpl as never });
    expect(FakeContext.order.indexOf('resume')).toBeGreaterThan(FakeContext.order.lastIndexOf('fetch'));
    expect(player.state()).toBe('suspended');
    player.play('hunt-step');
    expect(made[0]!.started).toHaveLength(0);
    await player.resume();
    expect(player.state()).toBe('running');
    player.play('hunt-step');
    expect(made[0]!.started).toHaveLength(1);
    player.close();
  });

  it('plays a cue at a given gain through its own gain node, and at the master volume otherwise', async () => {
    const ctx = new FakeContext();
    const gains: Array<{ gain: { value: number } }> = [];
    const original = ctx.createGain.bind(ctx);
    ctx.createGain = () => {
      const node = original();
      gains.push(node);
      return node;
    };
    const player = await createPlayer(ctx as never, { fetch: vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Response) as never });
    expect(gains).toHaveLength(1);
    player.play('hunt-step');
    expect(gains).toHaveLength(1);
    player.play('hunt-step', 0.5);
    expect(gains).toHaveLength(2);
    player.close();
  });

  it('rejects when a file is missing and when a file does not decode', async () => {
    const ok = { ok: true, arrayBuffer: async () => new ArrayBuffer(1) } as unknown as Response;
    const missing = vi.fn(async (url: string) => (url.includes('possessed') ? ({ ok: false } as Response) : ok));
    await expect(createPlayer(new FakeContext() as never, { fetch: missing as never })).rejects.toBeInstanceOf(Error);
    class BadDecode extends FakeContext {
      override async decodeAudioData(): Promise<never> {
        throw new Error('decode');
      }
    }
    await expect(createPlayer(new BadDecode() as never, { fetch: vi.fn(async () => ok) as never })).rejects.toBeInstanceOf(Error);
  });
});

describe('sound you hear at once (part 8)', () => {
  it('makes and resumes the AudioContext inside the click, before the player chunk is asked for or has loaded', () => {
    const order: string[] = [];
    const ctx = fakeContext();
    (ctx.resume as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('resume');
    });
    const make = vi.fn(() => {
      order.push('make');
      return ctx;
    });
    let release: (v: { createPlayer: () => Promise<SoundPlayer> }) => void = () => undefined;
    const load: LoadPlayer = vi.fn((): ReturnType<LoadPlayer> => {
      order.push('import');
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    render(<Harness services={[]} loadPlayer={load} makeContext={make} />);
    expect(make).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    // Synchronously, with the import still pending.
    expect(make).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['make', 'resume', 'import']);
    release({ createPlayer: async () => fakePlayer() as unknown as SoundPlayer });
  });

  it('makes the context in the first click of a stored on, also before the import resolves', () => {
    writeSoundOn(true);
    const make = vi.fn(defaultMakeContext);
    render(<Harness services={[]} loadPlayer={() => new Promise(() => undefined)} makeContext={make} />);
    expect(make).not.toHaveBeenCalled();
    fireEvent.click(document.body);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('makeContext (the real one) calls the AudioContext constructor and gives null without one', () => {
    expect(makeContext()).toBeNull();
    const made = vi.fn();
    vi.stubGlobal('AudioContext', class {
      constructor() {
        made();
      }
    });
    expect(makeContext()).not.toBeNull();
    expect(made).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('plays exactly one soft confirmation cue once the files are decoded, and none when turning off', async () => {
    const player = fakePlayer();
    render(<Harness services={[]} loadPlayer={loaderOf(player)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    await waitFor(() => expect(player.play).toHaveBeenCalledTimes(1));
    expect(player.play).toHaveBeenCalledWith('hunt-step', CONFIRM_GAIN);
    expect(CONFIRM_GAIN).toBe(0.5);
    for (let i = 0; i < 5; i++) await act(async () => undefined);
    expect(player.play).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Sound on' }));
    for (let i = 0; i < 5; i++) await act(async () => undefined);
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it('confirms again when sound is turned on a second time with the player ready (on, off, on)', async () => {
    const player = fakePlayer();
    render(<Harness services={[]} loadPlayer={loaderOf(player)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    await waitFor(() => expect(player.play).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Sound on' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    await waitFor(() => expect(player.play).toHaveBeenCalledTimes(2));
    expect(player.play).toHaveBeenLastCalledWith('hunt-step', CONFIRM_GAIN);
    for (let i = 0; i < 5; i++) await act(async () => undefined);
    expect(player.play).toHaveBeenCalledTimes(2);
  });

  it('plays no confirmation for a stored on that starts at the first click', async () => {
    writeSoundOn(true);
    const player = fakePlayer();
    const load = loaderOf(player);
    render(<Harness services={[]} loadPlayer={load} />);
    fireEvent.click(document.body);
    await waitFor(() => expect(load).toHaveBeenCalled());
    for (let i = 0; i < 5; i++) await act(async () => undefined);
    expect(player.play).not.toHaveBeenCalled();
  });

  describe('the silence hint', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    const settle = async (ms = 0) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    it('appears after 20 s without a cue (title and aria-describedby), is not shown when off, and goes away after a cue', async () => {
      const player = fakePlayer();
      const calm = [makeService('payments', { hauntLevel: 0 })];
      const dark = [makeService('payments', { hauntLevel: 4 })];
      const load = loaderOf(player);
      const { rerender } = render(<Harness services={calm} loadPlayer={load} />);
      await settle(SILENCE_HINT_MS * 2);
      expect(screen.getByRole('button', { name: 'Sound off' }).getAttribute('title')).toBeNull();
      expect(document.getElementById('sound-hint')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
      await settle(50);
      const button = screen.getByRole('button', { name: 'Sound on' });
      await settle(SILENCE_HINT_MS - 1000);
      expect(button.getAttribute('title')).toBeNull();
      await settle(1500);
      expect(button.getAttribute('title')).toBe('Sounds play when a room changes: ghosts, fog, a dark room, a hunt');
      expect(button.getAttribute('aria-describedby')).toBe('sound-hint');
      expect(document.getElementById('sound-hint')?.textContent).toBe('Sounds play when a room changes: ghosts, fog, a dark room, a hunt');
      // No live announcement and no toast.
      expect(document.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
      rerender(<Harness services={dark} loadPlayer={load} />);
      await settle(0);
      expect(button.getAttribute('title')).toBeNull();
      expect(button.getAttribute('aria-describedby')).toBeNull();
      expect(document.getElementById('sound-hint')).toBeNull();
      // Turning sound off hides it as well.
      await settle(SILENCE_HINT_MS + 100);
      expect(button.getAttribute('title')).not.toBeNull();
      fireEvent.click(button);
      await settle(0);
      expect(screen.getByRole('button', { name: 'Sound off' }).getAttribute('title')).toBeNull();
    });
  });

  it('shows "Sound unavailable" when no context can be made, stays clickable and retries with a new context', async () => {
    const player = fakePlayer();
    const load = loaderOf(player);
    let first = true;
    const make = vi.fn<MakeContext>(() => {
      if (first) {
        first = false;
        return null;
      }
      return fakeContext();
    });
    render(<Harness services={[]} loadPlayer={load} makeContext={make} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    const button = await screen.findByRole('button', { name: 'Sound unavailable' });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(make).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Sound on' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(player.play).toHaveBeenCalledWith('hunt-step', CONFIRM_GAIN));
  });
});
