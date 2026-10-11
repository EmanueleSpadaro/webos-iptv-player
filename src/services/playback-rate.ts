import { CONFIG } from '../config';
import {
  lunaRequest,
  type LunaRequestHandle,
  type LunaRequestOptions,
  type LunaResponse,
} from './luna';
import { isWebOS } from '../utils/platform';

export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export type PlaybackRate = typeof PLAYBACK_RATES[number];

export interface PlaybackRateState {
  available: boolean;
  rate: PlaybackRate;
}

type VideoWithMediaId = HTMLVideoElement & { mediaId?: string };
type RequestLuna = (
  uri: string,
  options?: LunaRequestOptions,
) => LunaRequestHandle;

export type PlaybackRateResult = 'applied' | 'failed' | 'superseded';

interface PlaybackRateControllerOptions {
  isWebOS?: boolean;
  requestLuna?: RequestLuna;
  // An applied rate was lost later (reapply failed or playback ignored it).
  onFallback?: () => void;
}

const VERIFY_INTERRUPTS = ['waiting', 'seeking', 'pause'];
const VERIFY_RESTARTS = ['playing', 'seeked'];

export class PlaybackRateController {
  private rate: PlaybackRate = 1;
  // Latest requested rate; pipeline events reapply this, even mid-request.
  private target: PlaybackRate = 1;
  private requestToken = 0;
  private rejected = false;
  private stopVerify: (() => void) | null = null;
  private readonly isWebOS: boolean;
  private readonly requestLuna: RequestLuna;
  private readonly onFallback: () => void;

  constructor(
    private getVideoElement: () => HTMLVideoElement | null,
    options: PlaybackRateControllerOptions = {},
  ) {
    this.isWebOS = options.isWebOS ?? isWebOS();
    this.requestLuna = options.requestLuna ?? lunaRequest;
    this.onFallback = options.onFallback ?? (() => {});
  }

  currentRate(): PlaybackRate {
    return this.rate;
  }

  // True once playback was measured ignoring an accepted rate; cleared by reset().
  isRejected(): boolean {
    return this.rejected;
  }

  reset(): void {
    this.requestToken++;
    this.stopVerify?.();
    const wasChanged = this.rate !== 1 || this.target !== 1;
    this.rate = 1;
    this.target = 1;
    this.rejected = false;
    const video = this.getVideoElement();
    if (!video) return;
    video.playbackRate = 1;
    if (wasChanged) this.resetNative(video);
  }

  async setRate(rate: PlaybackRate): Promise<PlaybackRateResult> {
    if (!this.isWebOS && this.rate === rate) return 'applied';
    const token = ++this.requestToken;
    this.stopVerify?.();
    const video = this.getVideoElement();
    if (!video) return 'failed';
    this.target = rate;

    const applied = this.isWebOS
      ? await this.applyNative(video, rate, token, true)
      : this.applyHtml(video, rate);
    if (token !== this.requestToken) return 'superseded';
    if (applied) {
      this.rate = rate;
      if (this.isWebOS && rate !== 1) this.verifyNative(video, rate);
      return 'applied';
    }

    // Invalidate a reapply still waiting on the same request.
    this.requestToken++;
    this.rate = 1;
    this.target = 1;
    video.playbackRate = 1;
    this.resetNative(video);
    return 'failed';
  }

  reapply(): void {
    const video = this.getVideoElement();
    const rate = this.target;
    if (!video || rate === 1) return;
    if (!this.isWebOS) {
      this.applyHtml(video, rate);
      return;
    }
    const token = this.requestToken;
    void this.applyNative(video, rate, token).then(applied => {
      if (token !== this.requestToken) return;
      if (!applied) this.fallBack(video, false);
      // The pipeline can drop a rate across a seek or rebuild while still
      // acknowledging it, so measure again.
      else if (this.rate === rate) this.verifyNative(video, rate);
    });
  }

  private fallBack(video: HTMLVideoElement, rejected: boolean): void {
    this.requestToken++;
    this.stopVerify?.();
    this.rate = 1;
    this.target = 1;
    if (rejected) this.rejected = true;
    video.playbackRate = 1;
    this.resetNative(video);
    this.onFallback();
  }

  // Best effort: an earlier native command may have taken effect before the
  // failure, so tell the pipeline 1x rather than assume it.
  private resetNative(video: HTMLVideoElement): void {
    const mediaId = (video as VideoWithMediaId).mediaId;
    if (this.isWebOS && mediaId) void this.requestNativeRate(mediaId, 1);
  }

  // Some native pipelines (HLS, DASH, older TVs) acknowledge setPlayRate but
  // keep playing at 1x, so measure how fast currentTime actually advances.
  // A pause, stall, or seek voids the sample; the next playing/seeked retries.
  private verifyNative(video: HTMLVideoElement, rate: PlaybackRate): void {
    this.stopVerify?.();
    if (!Number.isFinite(video.currentTime)) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let startMedia = 0;
    let startWall = 0;
    const cancelSample = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const begin = (): void => {
      cancelSample();
      if (video.paused) return;
      startMedia = video.currentTime;
      startWall = Date.now();
      timer = setTimeout(finish, CONFIG.PLAYER.PLAYBACK_RATE_VERIFY_MS);
    };
    const restart = (): void => {
      if (!video.paused) begin();
    };
    const stop = (): void => {
      cancelSample();
      VERIFY_INTERRUPTS.forEach(type => video.removeEventListener(type, cancelSample));
      VERIFY_RESTARTS.forEach(type => video.removeEventListener(type, restart));
      if (this.stopVerify === stop) this.stopVerify = null;
    };
    const finish = (): void => {
      timer = null;
      if (video !== this.getVideoElement()) {
        stop();
        return;
      }
      if (video.paused) return;
      const observed = (video.currentTime - startMedia) / ((Date.now() - startWall) / 1000);
      // A stall or jump without an event makes the sample meaningless.
      if (!(observed > PLAYBACK_RATES[0] / 2 && observed < 3)) {
        begin();
        return;
      }
      stop();
      if (Math.abs(observed - 1) < Math.abs(observed - rate)) this.fallBack(video, true);
    };
    VERIFY_INTERRUPTS.forEach(type => video.addEventListener(type, cancelSample));
    VERIFY_RESTARTS.forEach(type => video.addEventListener(type, restart));
    this.stopVerify = stop;
    begin();
  }

  private applyHtml(video: HTMLVideoElement, rate: PlaybackRate): boolean {
    try {
      video.playbackRate = rate;
      return Math.abs(video.playbackRate - rate) < 0.01;
    } catch {
      return false;
    }
  }

  private async applyNative(
    video: HTMLVideoElement,
    rate: PlaybackRate,
    token: number,
    reassert: boolean = false,
  ): Promise<boolean> {
    const mediaId = await this.waitForMediaId(video as VideoWithMediaId, token);
    if (!mediaId || token !== this.requestToken || video !== this.getVideoElement()) {
      return false;
    }
    if (!await this.requestNativeRate(mediaId, rate)) return false;
    if (!reassert) return true;

    for (let i = 0; i < CONFIG.PLAYER.PLAYBACK_RATE_REASSERT_COUNT; i++) {
      await new Promise(resolve => {
        setTimeout(resolve, CONFIG.PLAYER.PLAYBACK_RATE_REASSERT_MS);
      });
      const currentMediaId = (video as VideoWithMediaId).mediaId;
      if (!currentMediaId ||
        token !== this.requestToken ||
        video !== this.getVideoElement() ||
        !await this.requestNativeRate(currentMediaId, rate)) {
        return false;
      }
    }
    return true;
  }

  private waitForMediaId(video: VideoWithMediaId, token: number): Promise<string | null> {
    return new Promise(resolve => {
      const startedAt = Date.now();
      const check = (): void => {
        if (token !== this.requestToken || video !== this.getVideoElement()) {
          resolve(null);
          return;
        }
        if (video.mediaId) {
          resolve(video.mediaId);
          return;
        }
        if (Date.now() - startedAt >= CONFIG.PLAYER.PLAYBACK_RATE_MEDIA_TIMEOUT) {
          resolve(null);
          return;
        }
        setTimeout(check, CONFIG.PLAYER.PLAYBACK_RATE_MEDIA_POLL_MS);
      };
      check();
    });
  }

  private requestNativeRate(mediaId: string, rate: PlaybackRate): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false;
      let request: LunaRequestHandle | null = null;
      const finish = (success: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        request?.cancel();
        resolve(success);
      };
      const timeout = setTimeout(
        () => finish(false),
        CONFIG.PLAYER.PLAYBACK_RATE_LUNA_TIMEOUT,
      );
      const options: LunaRequestOptions<LunaResponse> = {
        method: 'setPlayRate',
        parameters: { mediaId, playRate: rate, audioOutput: true },
        onSuccess: () => finish(true),
        onFailure: () => finish(false),
      };
      request = this.requestLuna('luna://com.webos.media', options);
      if (settled) request.cancel();
    });
  }
}
