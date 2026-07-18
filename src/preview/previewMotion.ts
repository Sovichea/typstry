export type PreviewMotionState = "idle" | "moving" | "settling";
export type PreviewMotionPhase = "stationary" | "accelerating" | "cruising" | "decelerating";

export type PreviewMotionSnapshot = {
  state: PreviewMotionState;
  scrollTop: number;
  velocity: number;
  acceleration: number;
  direction: -1 | 0 | 1;
  phase: PreviewMotionPhase;
  deceleratingSamples: number;
  projectedScrollTop: number;
  shouldPreRender: boolean;
  stableFrames: number;
  pointerDown: boolean;
  firstStableFrame: boolean;
  becameIdle: boolean;
};

const POSITION_EPSILON_PX = 0.5;
const SPEED_CHANGE_EPSILON = 0.01;
const MIN_PRERENDER_SPEED = 0.08;
const REQUIRED_DECELERATION_SAMPLES = 2;
const MAX_STOPPING_DISTANCE_PX = 4_000;
const POINTER_STABLE_FALLBACK_FRAMES = 6;

export class PreviewMotionController {
  private state: PreviewMotionState = "idle";
  private scrollTop = 0;
  private sampledAt = 0;
  private velocity = 0;
  private acceleration = 0;
  private direction: -1 | 0 | 1 = 0;
  private phase: PreviewMotionPhase = "stationary";
  private deceleratingSamples = 0;
  private projectedScrollTop = 0;
  private stableFrames = 0;
  private pointerDown = false;

  public setPointerDown(pointerDown: boolean): void {
    this.pointerDown = pointerDown;
  }

  public noteScroll(scrollTop: number, timestamp: number): PreviewMotionSnapshot {
    const delta = scrollTop - this.scrollTop;
    const elapsed = Math.max(1, timestamp - this.sampledAt);
    if (Math.abs(delta) > POSITION_EPSILON_PX) {
      const nextVelocity = delta / elapsed;
      const nextDirection = delta > 0 ? 1 : -1;
      const previousSpeed = Math.abs(this.velocity);
      const nextSpeed = Math.abs(nextVelocity);
      const directionChanged = this.direction !== 0 && nextDirection !== this.direction;
      this.acceleration = directionChanged ? 0 : (nextSpeed - previousSpeed) / elapsed;
      if (directionChanged || nextSpeed > previousSpeed + SPEED_CHANGE_EPSILON) {
        this.phase = "accelerating";
        this.deceleratingSamples = 0;
      } else if (nextSpeed < previousSpeed - SPEED_CHANGE_EPSILON) {
        this.phase = "decelerating";
        this.deceleratingSamples += 1;
      } else {
        this.phase = "cruising";
        this.deceleratingSamples = 0;
      }
      this.velocity = nextVelocity;
      this.direction = nextDirection;
      this.scrollTop = scrollTop;
      this.sampledAt = timestamp;
      this.projectedScrollTop = this.projectStoppingPosition();
      this.stableFrames = 0;
      this.state = "moving";
    }
    return this.snapshot(false, false);
  }

  public sampleFrame(scrollTop: number, timestamp: number): PreviewMotionSnapshot {
    const delta = scrollTop - this.scrollTop;
    if (Math.abs(delta) > POSITION_EPSILON_PX) return this.noteScroll(scrollTop, timestamp);

    if (this.state === "idle") return this.snapshot(false, false);
    this.stableFrames += 1;
    const firstStableFrame = this.stableFrames === 1;
    // Native WebView scrollbars do not reliably dispatch pointerup into the
    // iframe. Stable position therefore becomes authoritative after a short
    // fallback window even when the last observed pointer state remains down.
    const becameIdle = this.stableFrames >= 3
      && (!this.pointerDown || this.stableFrames >= POINTER_STABLE_FALLBACK_FRAMES);
    this.state = becameIdle ? "idle" : "settling";
    if (becameIdle) {
      this.velocity = 0;
      this.acceleration = 0;
      this.phase = "stationary";
      this.deceleratingSamples = 0;
      this.projectedScrollTop = scrollTop;
    }
    return this.snapshot(firstStableFrame, becameIdle);
  }

  public reset(scrollTop = 0, timestamp = 0): void {
    this.state = "idle";
    this.scrollTop = scrollTop;
    this.sampledAt = timestamp;
    this.velocity = 0;
    this.acceleration = 0;
    this.direction = 0;
    this.phase = "stationary";
    this.deceleratingSamples = 0;
    this.projectedScrollTop = scrollTop;
    this.stableFrames = 0;
    this.pointerDown = false;
  }

  public current(): PreviewMotionSnapshot {
    return this.snapshot(false, false);
  }

  private snapshot(firstStableFrame: boolean, becameIdle: boolean): PreviewMotionSnapshot {
    return {
      state: this.state,
      scrollTop: this.scrollTop,
      velocity: this.velocity,
      acceleration: this.acceleration,
      direction: this.direction,
      phase: this.phase,
      deceleratingSamples: this.deceleratingSamples,
      projectedScrollTop: this.projectedScrollTop,
      shouldPreRender: this.state === "moving"
        && !this.pointerDown
        && this.phase === "decelerating"
        && this.deceleratingSamples >= REQUIRED_DECELERATION_SAMPLES
        && Math.abs(this.velocity) >= MIN_PRERENDER_SPEED,
      stableFrames: this.stableFrames,
      pointerDown: this.pointerDown,
      firstStableFrame,
      becameIdle
    };
  }

  private projectStoppingPosition(): number {
    if (this.phase !== "decelerating" || this.acceleration >= 0) return this.scrollTop;
    const speed = Math.abs(this.velocity);
    const stoppingDistance = Math.min(
      MAX_STOPPING_DISTANCE_PX,
      speed * speed / Math.max(0.0001, -2 * this.acceleration)
    );
    return Math.max(0, this.scrollTop + this.direction * stoppingDistance);
  }
}
