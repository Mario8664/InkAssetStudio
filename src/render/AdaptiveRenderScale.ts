const MAX_PIXEL_RATIO = 2;
const MIN_PIXEL_RATIO = 1;
const HIGH_DENSITY_PIXEL_BUDGET = 2_000_000;
const SCALE_STEP = 0.25;
const SLOW_FRAME_MILLISECONDS = 22;
const FAST_FRAME_MILLISECONDS = 14;
const SLOW_FRAME_COUNT = 3;
const FAST_FRAME_COUNT = 120;
const SCALE_CHANGE_COOLDOWN_MILLISECONDS = 1_000;

/**
 * Keeps the WebGL backing store inside a practical pixel budget on high-DPI
 * devices, then adjusts only after sustained frame pressure or headroom.
 */
export class AdaptiveRenderScale {
  private maximumPixelRatio = MAX_PIXEL_RATIO;
  private pixelRatio = MAX_PIXEL_RATIO;
  private interactionActive = false;
  private slowFrameCount = 0;
  private fastFrameCount = 0;
  private lastChangeAt = Number.NEGATIVE_INFINITY;

  setViewport(width: number, height: number, devicePixelRatio: number): number {
    const safeWidth = Math.max(1, Math.round(width));
    const safeHeight = Math.max(1, Math.round(height));
    const requestedRatio = clamp(devicePixelRatio, MIN_PIXEL_RATIO, MAX_PIXEL_RATIO);
    const pixelBudgetRatio = Math.sqrt(HIGH_DENSITY_PIXEL_BUDGET / (safeWidth * safeHeight));
    this.maximumPixelRatio = Math.max(MIN_PIXEL_RATIO, Math.min(requestedRatio, pixelBudgetRatio));
    if (this.pixelRatio > this.maximumPixelRatio) this.pixelRatio = this.maximumPixelRatio;
    return this.pixelRatio;
  }

  setInteractionActive(active: boolean): void {
    this.interactionActive = active;
    this.slowFrameCount = 0;
    this.fastFrameCount = 0;
  }

  /** Returns a new ratio only after sustained pressure or sustained headroom. */
  reportFrame(frameMilliseconds: number, now: number): number | null {
    if (this.interactionActive || !Number.isFinite(frameMilliseconds) || !Number.isFinite(now)) return null;
    if (now - this.lastChangeAt < SCALE_CHANGE_COOLDOWN_MILLISECONDS) return null;
    if (frameMilliseconds >= SLOW_FRAME_MILLISECONDS) {
      this.slowFrameCount += 1;
      this.fastFrameCount = 0;
      if (this.slowFrameCount < SLOW_FRAME_COUNT || this.pixelRatio <= MIN_PIXEL_RATIO) return null;
      return this.setPixelRatio(this.pixelRatio - SCALE_STEP, now);
    }
    if (frameMilliseconds <= FAST_FRAME_MILLISECONDS) {
      this.fastFrameCount += 1;
      this.slowFrameCount = 0;
      if (this.fastFrameCount < FAST_FRAME_COUNT || this.pixelRatio >= this.maximumPixelRatio) return null;
      return this.setPixelRatio(this.pixelRatio + SCALE_STEP, now);
    }
    this.slowFrameCount = 0;
    this.fastFrameCount = 0;
    return null;
  }

  private setPixelRatio(next: number, now: number): number | null {
    const resolved = clamp(roundToQuarter(next), MIN_PIXEL_RATIO, this.maximumPixelRatio);
    this.slowFrameCount = 0;
    this.fastFrameCount = 0;
    if (resolved === this.pixelRatio) return null;
    this.pixelRatio = resolved;
    this.lastChangeAt = now;
    return resolved;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundToQuarter(value: number): number {
  return Math.round(value / SCALE_STEP) * SCALE_STEP;
}
