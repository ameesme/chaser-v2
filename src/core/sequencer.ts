import type { FeatureValue, PlayheadState, ProgramDefinition } from "../config/types.js";
import { performance } from "node:perf_hooks";

export type SequencerFrame = {
  timestamp: number;
  values: Record<string, number[]>;
  state: PlayheadState;
};

function frameKey(fixtureId: string, featureId: string): string {
  return `${fixtureId}:${featureId}`;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function asArray(value: FeatureValue): number[] {
  return Array.isArray(value) ? value : [value];
}

function isZeroValue(values: number[]): boolean {
  return values.every((value) => value <= 0);
}

export class Sequencer {
  private state: PlayheadState = {
    isPlaying: false,
    isBlackout: false,
    programId: null,
    stepIndex: 0,
    positionMs: 0,
    spm: 120,
    loop: true,
  };

  private timer: NodeJS.Timeout | null = null;
  private frameIntervalMs = 33;
  private lastTickAtMs: number | null = null;
  private listeners = new Set<(frame: SequencerFrame) => void>();
  private activeProgram: ProgramDefinition | null = null;

  setProgram(program: ProgramDefinition): void {
    this.activeProgram = program;
    this.state.programId = program.id;
    this.state.spm = Math.max(1, Math.min(500, Math.round(program.spm)));
    this.state.loop = program.loop;
    this.state.stepIndex = 0;
    this.state.positionMs = 0;
    this.emitFrame();
  }

  getState(): PlayheadState {
    return { ...this.state };
  }

  getProgramId(): string | null {
    return this.state.programId;
  }

  getFrame(): SequencerFrame {
    return this.buildFrame();
  }

  play(): void {
    if (!this.activeProgram) return;
    if (this.state.isPlaying) return;
    this.state.stepIndex = 0;
    this.state.positionMs = 0;
    this.state.isPlaying = true;
    this.emitFrame();
    this.startTimer();
  }

  pause(): void {
    this.state.isPlaying = false;
    this.stopTimer();
    this.emitFrame();
  }

  nextStep(): void {
    if (!this.activeProgram || this.activeProgram.steps.length === 0) return;
    if (!this.state.loop && this.state.stepIndex >= this.activeProgram.steps.length - 1) {
      this.state.stepIndex = this.activeProgram.steps.length - 1;
    } else {
      this.state.stepIndex = (this.state.stepIndex + 1) % this.activeProgram.steps.length;
    }
    this.state.positionMs = 0;
    this.emitFrame();
  }

  previousStep(): void {
    if (!this.activeProgram || this.activeProgram.steps.length === 0) return;
    if (!this.state.loop && this.state.stepIndex <= 0) {
      this.state.stepIndex = 0;
    } else {
      this.state.stepIndex =
        (this.state.stepIndex - 1 + this.activeProgram.steps.length) % this.activeProgram.steps.length;
    }
    this.state.positionMs = 0;
    this.emitFrame();
  }

  setStep(stepIndex: number): void {
    if (!this.activeProgram) return;
    const clamped = Math.max(0, Math.floor(stepIndex));
    this.ensureProgramStep(clamped);
    this.state.stepIndex = clamped;
    this.state.positionMs = 0;
    this.emitFrame();
  }

  setSpm(spm: number): void {
    this.state.spm = Math.max(1, Math.min(500, Math.round(spm)));
    this.emitFrame();
  }

  setLoop(enabled: boolean): void {
    this.state.loop = enabled;
    this.emitFrame();
  }

  setFrameRate(fps: number): void {
    const clampedFps = Math.max(1, Math.min(120, Math.round(fps)));
    this.frameIntervalMs = Math.max(1, Math.round(1000 / clampedFps));
    if (this.state.isPlaying) {
      this.stopTimer();
      this.startTimer();
    }
  }

  setBlackout(enabled: boolean): void {
    this.state.isBlackout = enabled;
    this.emitFrame();
  }

  subscribe(listener: (frame: SequencerFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private startTimer(): void {
    if (this.timer) return;
    this.lastTickAtMs = performance.now();
    this.timer = setInterval(() => this.tick(), this.frameIntervalMs);
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.lastTickAtMs = null;
  }

  private tick(): void {
    if (!this.activeProgram || !this.state.isPlaying) return;
    this.ensureProgramStep(this.state.stepIndex);
    const steps = this.activeProgram.steps;
    if (steps.length === 0) return;

    const nowMs = performance.now();
    const elapsedMsRaw = this.lastTickAtMs === null ? this.frameIntervalMs : nowMs - this.lastTickAtMs;
    this.lastTickAtMs = nowMs;
    const elapsedMs = Math.max(0, Math.min(1000, elapsedMsRaw));

    this.state.positionMs += elapsedMs;

    while (this.state.isPlaying) {
      const step = steps[this.state.stepIndex];
      const baseStepDurationMs = 500;
      const stepScale = Math.max(1, step.durationMs) / baseStepDurationMs;
      const targetStepDurationMs = (60000 / this.state.spm) * stepScale;

      if (this.state.positionMs < targetStepDurationMs) break;
      this.state.positionMs -= targetStepDurationMs;

      if (this.state.stepIndex >= steps.length - 1) {
        if (this.state.loop) {
          this.state.stepIndex = 0;
        } else {
          this.state.stepIndex = steps.length - 1;
          this.state.positionMs = 0;
          this.state.isPlaying = false;
          this.stopTimer();
          break;
        }
      } else {
        this.state.stepIndex += 1;
      }
    }

    this.emitFrame();
  }

  private ensureProgramStep(stepIndex: number): void {
    if (!this.activeProgram) return;
    while (this.activeProgram.steps.length <= stepIndex) {
      const index = this.activeProgram.steps.length;
      const prev = index > 0 ? this.activeProgram.steps[index - 1] : null;
      this.activeProgram.steps.push({
        id: `step-${index + 1}`,
        durationMs: prev?.durationMs ?? 500,
        fadeMs: prev?.fadeMs ?? 300,
        frames: [],
      });
    }
  }

  private emitFrame(): void {
    const frame = this.buildFrame();
    for (const listener of this.listeners) {
      listener(frame);
    }
  }

  private buildFrame(): SequencerFrame {
    if (!this.activeProgram || this.activeProgram.steps.length === 0) {
      return {
        timestamp: Date.now(),
        values: {},
        state: { ...this.state },
      };
    }

    const steps = this.activeProgram.steps;
    const currentStep = steps[this.state.stepIndex];
    const previousIndex = this.state.stepIndex > 0
      ? this.state.stepIndex - 1
      : this.state.loop
        ? steps.length - 1
        : 0;
    const previousStep = steps[previousIndex];

    const currentMap = new Map<string, number[]>();
    for (const frame of currentStep.frames) {
      currentMap.set(frameKey(frame.fixtureId, frame.featureId), asArray(frame.value));
    }

    const prevMap = new Map<string, number[]>();
    for (const frame of previousStep.frames) {
      prevMap.set(frameKey(frame.fixtureId, frame.featureId), asArray(frame.value));
    }

    const keys = new Set([...currentMap.keys(), ...prevMap.keys()]);
    const fadeRatio = this.state.isPlaying
      ? currentStep.fadeMs > 0
        ? clamp01(this.state.positionMs / currentStep.fadeMs)
        : 1
      : 1;

    const values: Record<string, number[]> = {};
    for (const key of keys) {
      const from = prevMap.get(key) ?? [0];
      const to = currentMap.get(key) ?? [0];
      const length = Math.max(from.length, to.length);
      const out: number[] = [];

      for (let i = 0; i < length; i += 1) {
        const fromValue = from[i] ?? 0;
        const toValue = to[i] ?? 0;
        out.push(
          this.state.isBlackout ? 0 : Math.round(fromValue + (toValue - fromValue) * fadeRatio),
        );
      }

      if (!isZeroValue(out)) {
        values[key] = out;
      }
    }

    return {
      timestamp: Date.now(),
      values,
      state: { ...this.state },
    };
  }
}
