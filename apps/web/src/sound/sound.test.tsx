import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceState } from '@haunted-ops/shared';
import { Header } from '../components/Header.js';
import { SoundButton } from '../components/SoundButton.js';
import { makeService } from '../test/arbs.js';
import { SOUND_KEY, readSoundOn, writeSoundOn } from './storage.js';
import { CUE_FILES, MASTER_GAIN, createPlayer, type SoundPlayer } from './player.js';
import { useSound, type LoadPlayer } from './useSound.js';

function Harness({ services, loadPlayer, enabled = true }: { services: ServiceState[]; loadPlayer: LoadPlayer; enabled?: boolean }) {
  const sound = useSound(services, { loadPlayer, enabled });
  return <SoundButton on={sound.on} unavailable={sound.unavailable} onToggle={sound.toggle} />;
}

const fakePlayer = () => ({
  play: vi.fn<(cue: string) => void>(),
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

  it('says "Sound unavailable" and is disabled when the sound cannot work', () => {
    render(<SoundButton on unavailable onToggle={() => undefined} />);
    const button = screen.getByRole('button', { name: 'Sound unavailable' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('false');
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
    const player = await createPlayer({ AudioContext: FakeContext as never, fetch: fetchImpl as never });
    expect(asked.sort()).toEqual(Object.values(CUE_FILES).sort());
    for (const url of asked) expect(url).toMatch(/^\/sfx\/[a-z-]+\.mp3$/);
    expect(MASTER_GAIN).toBe(0.6);
    player.play('hunt-step');
    player.play('hunt-step');
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(FakeContext.made).toBe(1);
    player.close();
  });

  it('calls resume before the first fetch, plays only while running and never queues a cue for later', async () => {
    FakeContext.order = [];
    class Suspended extends FakeContext {
      override async resume() {
        FakeContext.order.push('resume');
        // The browser refuses at first: the context stays suspended until `resume` is called again.
        if (FakeContext.order.filter((o) => o === 'resume').length >= 3) this.state = 'running';
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
    const player = await createPlayer({ AudioContext: Made as never, fetch: fetchImpl as never });
    expect(FakeContext.order[0]).toBe('resume');
    expect(FakeContext.order.indexOf('resume')).toBeLessThan(FakeContext.order.indexOf('fetch'));
    expect(player.state()).toBe('suspended');
    player.play('hunt-step');
    expect(made[0]!.started).toHaveLength(0);
    await player.resume();
    expect(player.state()).toBe('running');
    player.play('hunt-step');
    expect(made[0]!.started).toHaveLength(1);
    player.close();
  });

  it('rejects when there is no AudioContext, when a file is missing and when a file does not decode', async () => {
    await expect(createPlayer({ AudioContext: undefined, fetch: vi.fn() as never })).rejects.toBeInstanceOf(Error);
    const ok = { ok: true, arrayBuffer: async () => new ArrayBuffer(1) } as unknown as Response;
    const missing = vi.fn(async (url: string) => (url.includes('possessed') ? ({ ok: false } as Response) : ok));
    await expect(createPlayer({ AudioContext: FakeContext as never, fetch: missing as never })).rejects.toBeInstanceOf(Error);
    class BadDecode extends FakeContext {
      override async decodeAudioData(): Promise<never> {
        throw new Error('decode');
      }
    }
    await expect(createPlayer({ AudioContext: BadDecode as never, fetch: vi.fn(async () => ok) as never })).rejects.toBeInstanceOf(Error);
  });
});
