// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LunaRequestHandle,
  LunaRequestOptions,
  LunaResponse,
} from './luna';
import { PlaybackRateController } from './playback-rate';

function video(): HTMLVideoElement {
  return { playbackRate: 1 } as HTMLVideoElement;
}

describe('PlaybackRateController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses HTMLMediaElement playbackRate outside webOS', async () => {
    const el = video();
    const controller = new PlaybackRateController(() => el, { isWebOS: false });

    await expect(controller.setRate(1.5)).resolves.toBe('applied');

    expect(el.playbackRate).toBe(1.5);
    expect(controller.currentRate()).toBe(1.5);
  });

  it('waits for mediaId and calls the native webOS play-rate API', async () => {
    const el = video() as HTMLVideoElement & { mediaId?: string };
    const requestLuna = vi.fn((
      _uri: string,
      options: LunaRequestOptions = {},
    ): LunaRequestHandle => {
      options.onSuccess?.({ returnValue: true });
      return { cancel: vi.fn() };
    });
    const controller = new PlaybackRateController(
      () => el,
      { isWebOS: true, requestLuna },
    );

    const result = controller.setRate(2);
    el.mediaId = 'media1';
    await vi.advanceTimersByTimeAsync(750);

    await expect(result).resolves.toBe('applied');
    expect(requestLuna).toHaveBeenCalledTimes(3);
    expect(requestLuna).toHaveBeenCalledWith(
      'luna://com.webos.media',
      expect.objectContaining({
        method: 'setPlayRate',
        parameters: {
          mediaId: 'media1',
          playRate: 2,
          audioOutput: true,
        },
      }),
    );
    expect(controller.currentRate()).toBe(2);
  });

  it('rejects a failed native request and returns to 1x', async () => {
    const el = Object.assign(video(), { mediaId: 'media1' });
    const requestLuna = (
      _uri: string,
      options: LunaRequestOptions = {},
    ): LunaRequestHandle => {
      options.onFailure?.({ returnValue: false } as LunaResponse);
      return { cancel: vi.fn() };
    };
    const controller = new PlaybackRateController(
      () => el,
      { isWebOS: true, requestLuna },
    );

    await expect(controller.setRate(1.25)).resolves.toBe('failed');
    expect(controller.currentRate()).toBe(1);
    expect(el.playbackRate).toBe(1);
  });

  it('reapplies an active native rate after a pipeline event', async () => {
    const el = Object.assign(video(), { mediaId: 'media1' });
    const requests: LunaRequestOptions[] = [];
    const requestLuna = (
      _uri: string,
      options: LunaRequestOptions = {},
    ): LunaRequestHandle => {
      requests.push(options);
      options.onSuccess?.({ returnValue: true });
      return { cancel: vi.fn() };
    };
    const controller = new PlaybackRateController(
      () => el,
      { isWebOS: true, requestLuna },
    );
    const initial = controller.setRate(1.5);
    await vi.advanceTimersByTimeAsync(500);
    await initial;

    controller.reapply();
    await Promise.resolve();

    expect(requests).toHaveLength(4);
    expect(requests[3].parameters).toEqual({
      mediaId: 'media1',
      playRate: 1.5,
      audioOutput: true,
    });
  });

  describe('native rate verification', () => {
    const succeed = (
      _uri: string,
      options: LunaRequestOptions = {},
    ): LunaRequestHandle => {
      options.onSuccess?.({ returnValue: true });
      return { cancel: vi.fn() };
    };

    // A playing element whose currentTime advances at `actualRate` x wall time.
    function playing(actualRate: number): HTMLVideoElement & { mediaId: string } {
      const startedAt = Date.now();
      const el = Object.assign(new EventTarget(), {
        playbackRate: 1,
        paused: false,
        mediaId: 'media1',
      });
      Object.defineProperty(el, 'currentTime', {
        get: () => (Date.now() - startedAt) / 1000 * actualRate,
      });
      return el as unknown as HTMLVideoElement & { mediaId: string };
    }

    async function apply(el: HTMLVideoElement, rate: 2 | 0.5): Promise<{
      controller: PlaybackRateController;
      onFallback: ReturnType<typeof vi.fn>;
    }> {
      const onFallback = vi.fn();
      const controller = new PlaybackRateController(
        () => el,
        { isWebOS: true, requestLuna: succeed, onFallback },
      );
      const result = controller.setRate(rate);
      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toBe('applied');
      return { controller, onFallback };
    }

    it('returns to 1x when an accepted rate leaves playback at 1x', async () => {
      const el = playing(1);
      const { controller, onFallback } = await apply(el, 2);

      await vi.advanceTimersByTimeAsync(3000);

      expect(onFallback).toHaveBeenCalledTimes(1);
      expect(controller.currentRate()).toBe(1);
      expect(controller.isRejected()).toBe(true);
    });

    it('also catches a slow-down that does not take effect', async () => {
      const { controller, onFallback } = await apply(playing(1), 0.5);

      await vi.advanceTimersByTimeAsync(3000);

      expect(onFallback).toHaveBeenCalledTimes(1);
      expect(controller.currentRate()).toBe(1);
    });

    it('keeps a rate that playback actually follows', async () => {
      const { controller, onFallback } = await apply(playing(1.97), 2);

      await vi.advanceTimersByTimeAsync(3000);

      expect(onFallback).not.toHaveBeenCalled();
      expect(controller.currentRate()).toBe(2);
      expect(controller.isRejected()).toBe(false);
    });

    it('treats a buffering stall as inconclusive', async () => {
      const el = playing(1);
      const { controller, onFallback } = await apply(el, 2);

      el.dispatchEvent(new Event('waiting'));
      await vi.advanceTimersByTimeAsync(3000);

      expect(onFallback).not.toHaveBeenCalled();
      expect(controller.currentRate()).toBe(2);
    });

    it('measures once playback starts when the rate was picked while paused', async () => {
      const el = playing(1);
      Object.assign(el, { paused: true });
      const { controller, onFallback } = await apply(el, 2);
      await vi.advanceTimersByTimeAsync(3000);
      expect(onFallback).not.toHaveBeenCalled();

      Object.assign(el, { paused: false });
      el.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(3000);

      expect(onFallback).toHaveBeenCalledTimes(1);
      expect(controller.currentRate()).toBe(1);
    });

    it('measures again after a stall interrupts the sample', async () => {
      const el = playing(1);
      const { controller, onFallback } = await apply(el, 2);

      el.dispatchEvent(new Event('waiting'));
      await vi.advanceTimersByTimeAsync(3000);
      el.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(3000);

      expect(onFallback).toHaveBeenCalledTimes(1);
      expect(controller.currentRate()).toBe(1);
    });

    it('stops measuring when the next video starts', async () => {
      const el = playing(1);
      const { controller, onFallback } = await apply(el, 2);

      controller.reset();
      await vi.advanceTimersByTimeAsync(3000);
      el.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(3000);

      expect(onFallback).not.toHaveBeenCalled();
    });

    it('clears the rejection when the next video starts', async () => {
      const { controller } = await apply(playing(1), 2);
      await vi.advanceTimersByTimeAsync(3000);

      controller.reset();

      expect(controller.isRejected()).toBe(false);
    });
  });

  describe('overlapping requests', () => {
    function recordingLuna(requests: LunaRequestOptions[], ok: () => boolean = () => true) {
      return (_uri: string, options: LunaRequestOptions = {}): LunaRequestHandle => {
        requests.push(options);
        if (ok()) options.onSuccess?.({ returnValue: true });
        else options.onFailure?.({ returnValue: false } as LunaResponse);
        return { cancel: vi.fn() };
      };
    }

    it('returns the native rate to 1x when the next video starts', async () => {
      const el = Object.assign(video(), { mediaId: 'media1' });
      const requests: LunaRequestOptions[] = [];
      const controller = new PlaybackRateController(
        () => el,
        { isWebOS: true, requestLuna: recordingLuna(requests) },
      );
      const applied = controller.setRate(2);
      await vi.advanceTimersByTimeAsync(500);
      await applied;

      controller.reset();
      await vi.advanceTimersByTimeAsync(500);

      const last = requests[requests.length - 1].parameters as { playRate: number };
      expect(last.playRate).toBe(1);
    });

    it('sends no native request on reset when the rate never changed', () => {
      const el = Object.assign(video(), { mediaId: 'media1' });
      const requests: LunaRequestOptions[] = [];
      const controller = new PlaybackRateController(
        () => el,
        { isWebOS: true, requestLuna: recordingLuna(requests) },
      );

      controller.reset();

      expect(requests).toHaveLength(0);
    });

    it('reapplies the newly requested rate while a change is in flight', async () => {
      const el = Object.assign(video(), { mediaId: 'media1' });
      const requests: LunaRequestOptions[] = [];
      const controller = new PlaybackRateController(
        () => el,
        { isWebOS: true, requestLuna: recordingLuna(requests) },
      );
      const first = controller.setRate(1.5);
      await vi.advanceTimersByTimeAsync(500);
      await first;

      const second = controller.setRate(2);
      controller.reapply();
      await vi.advanceTimersByTimeAsync(500);
      await second;

      const rates = requests.slice(3).map(r => (r.parameters as { playRate: number }).playRate);
      expect(rates).not.toContain(1.5);
      expect(controller.currentRate()).toBe(2);
    });

    it('reports a request replaced by a newer one as superseded, not failed', async () => {
      const el = video() as HTMLVideoElement & { mediaId?: string };
      const controller = new PlaybackRateController(
        () => el,
        { isWebOS: true, requestLuna: recordingLuna([]) },
      );

      const first = controller.setRate(1.5);
      const second = controller.setRate(2);
      el.mediaId = 'media1';
      await vi.advanceTimersByTimeAsync(1000);

      await expect(first).resolves.toBe('superseded');
      await expect(second).resolves.toBe('applied');
    });

    it('signals a fallback when reapplying after a pipeline event fails', async () => {
      const el = Object.assign(video(), { mediaId: 'media1' });
      let ok = true;
      const onFallback = vi.fn();
      const controller = new PlaybackRateController(
        () => el,
        { isWebOS: true, requestLuna: recordingLuna([], () => ok), onFallback },
      );
      const result = controller.setRate(1.5);
      await vi.advanceTimersByTimeAsync(500);
      await result;

      ok = false;
      controller.reapply();
      await vi.advanceTimersByTimeAsync(0);

      expect(onFallback).toHaveBeenCalledTimes(1);
      expect(controller.currentRate()).toBe(1);
      expect(controller.isRejected()).toBe(false);
    });
  });

  describe('native state after a lost rate', () => {
    function luna(requests: LunaRequestOptions[], fail: (n: number) => boolean) {
      return (_uri: string, options: LunaRequestOptions = {}): LunaRequestHandle => {
        requests.push(options);
        if (fail(requests.length)) options.onFailure?.({ returnValue: false } as LunaResponse);
        else options.onSuccess?.({ returnValue: true });
        return { cancel: vi.fn() };
      };
    }
    const lastRate = (requests: LunaRequestOptions[]): unknown =>
      (requests[requests.length - 1].parameters as { playRate: number }).playRate;

    it('tells the pipeline 1x when a reassertion fails', async () => {
      const el = Object.assign(video(), { mediaId: 'media1' });
      const requests: LunaRequestOptions[] = [];
      const controller = new PlaybackRateController(
        () => el,
        { isWebOS: true, requestLuna: luna(requests, n => n === 2) },
      );

      const result = controller.setRate(2);
      await vi.advanceTimersByTimeAsync(500);

      await expect(result).resolves.toBe('failed');
      expect(lastRate(requests)).toBe(1);
    });

    it('tells the pipeline 1x when a reapply fails', async () => {
      const el = Object.assign(video(), { mediaId: 'media1' });
      const requests: LunaRequestOptions[] = [];
      const controller = new PlaybackRateController(
        () => el,
        { isWebOS: true, requestLuna: luna(requests, n => n === 4) },
      );
      const result = controller.setRate(2);
      await vi.advanceTimersByTimeAsync(500);
      await result;

      controller.reapply();
      await vi.advanceTimersByTimeAsync(0);

      expect(requests).toHaveLength(5);
      expect(lastRate(requests)).toBe(1);
    });

    it('measures again after a reapply the pipeline then ignores', async () => {
      let actual = 2;
      let media = 0;
      let wall = Date.now();
      const el = Object.assign(new EventTarget(), {
        playbackRate: 1, paused: false, mediaId: 'media1',
      });
      Object.defineProperty(el, 'currentTime', {
        get: () => media + (Date.now() - wall) / 1000 * actual,
      });
      const onFallback = vi.fn();
      const controller = new PlaybackRateController(
        () => el as unknown as HTMLVideoElement,
        { isWebOS: true, requestLuna: luna([], () => false), onFallback },
      );
      const result = controller.setRate(2);
      await vi.advanceTimersByTimeAsync(500);
      await result;
      await vi.advanceTimersByTimeAsync(3000);
      expect(onFallback).not.toHaveBeenCalled();

      media = (el as unknown as HTMLVideoElement).currentTime;
      wall = Date.now();
      actual = 1;
      controller.reapply();
      await vi.advanceTimersByTimeAsync(3000);

      expect(onFallback).toHaveBeenCalledTimes(1);
      expect(controller.isRejected()).toBe(true);
    });
  });

  it('does not let a pending reapply send the rate after the request failed', async () => {
    const el = video() as HTMLVideoElement & { mediaId?: string };
    const requests: LunaRequestOptions[] = [];
    const requestLuna = (_uri: string, options: LunaRequestOptions = {}): LunaRequestHandle => {
      requests.push(options);
      options.onSuccess?.({ returnValue: true });
      return { cancel: vi.fn() };
    };
    const controller = new PlaybackRateController(() => el, { isWebOS: true, requestLuna });

    const result = controller.setRate(2);
    await vi.advanceTimersByTimeAsync(2500);
    controller.reapply();
    await vi.advanceTimersByTimeAsync(2500);
    await expect(result).resolves.toBe('failed');

    el.mediaId = 'media1';
    await vi.advanceTimersByTimeAsync(500);

    expect(requests.map(r => (r.parameters as { playRate: number }).playRate))
      .not.toContain(2);
  });
});
