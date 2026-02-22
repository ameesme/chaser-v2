import type { FeatureValue, PlayheadState, ProgramDefinition } from "../config/types.js";
import { performance } from "node:perf_hooks";

type LayerValueMap = Record<string, number[]>;

export type SequencerFrame = {
  timestamp: number;
  values: Record<string, number[]>;
  layerAValues: LayerValueMap;
  layerBValues: LayerValueMap;
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

function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 255) return 255;
  return Math.round(value);
}

function isZeroValue(values: number[]): boolean {
  return values.every((value) => value <= 0);
}

function cloneLayerValues(values: LayerValueMap): LayerValueMap {
  const clone: LayerValueMap = {};
  for (const [key, entry] of Object.entries(values)) {
    clone[key] = [...entry];
  }
  return clone;
}

function addLayerValues(layerA: LayerValueMap, layerB: LayerValueMap): LayerValueMap {
  const combined: LayerValueMap = {};
  const keys = new Set([...Object.keys(layerA), ...Object.keys(layerB)]);
  for (const key of keys) {
    const a = layerA[key] ?? [0];
    const b = layerB[key] ?? [0];
    const length = Math.max(a.length, b.length);
    const out: number[] = [];
    for (let i = 0; i < length; i += 1) {
      const aValue = a[i] ?? a[0] ?? 0;
      const bValue = b[i] ?? b[0] ?? 0;
      out.push(clampChannel(aValue + bValue));
    }
    if (!isZeroValue(out)) combined[key] = out;
  }
  return combined;
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
  private layerAValues: LayerValueMap = {};
  private debug = process.env.CHASER_DEBUG === "1";

  setProgram(program: ProgramDefinition, options?: { preservePlayhead?: boolean; suppressEmit?: boolean }): void {
    this.trace("setProgram:begin", {
      programId: program.id,
      preservePlayhead: Boolean(options?.preservePlayhead),
      steps: program.steps.length,
      prevState: this.state,
    });
    this.activeProgram = program;
    this.state.programId = program.id;
    this.state.spm = Math.max(1, Math.min(500, Math.round(program.spm)));
    this.state.loop = program.loop;
    if (options?.preservePlayhead) {
      const maxStepIndex = Math.max(0, program.steps.length - 1);
      this.state.stepIndex = Math.min(this.state.stepIndex, maxStepIndex);
    } else {
      this.state.stepIndex = 0;
      this.state.positionMs = 0;
    }
    if (!options?.suppressEmit) {
      this.emitFrame();
    }
    this.trace("setProgram:end", { state: this.state });
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
    this.trace("play", { state: this.state });
  }

  resume(): void {
    if (!this.activeProgram) return;
    if (this.state.isPlaying) return;
    this.state.isPlaying = true;
    this.emitFrame();
    this.startTimer();
    this.trace("resume", { state: this.state });
  }

  pause(): void {
    this.state.isPlaying = false;
    this.stopTimer();
    this.emitFrame();
    this.trace("pause", { state: this.state });
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
    this.trace("nextStep", { state: this.state });
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
    this.trace("previousStep", { state: this.state });
  }

  setStep(stepIndex: number): void {
    if (!this.activeProgram) return;
    const clamped = Math.max(0, Math.floor(stepIndex));
    this.ensureProgramStep(clamped);
    this.state.stepIndex = clamped;
    this.state.positionMs = 0;
    this.emitFrame();
    this.trace("setStep", { input: stepIndex, clamped, state: this.state });
  }

  setSpm(spm: number): void {
    this.state.spm = Math.max(1, Math.min(500, Math.round(spm)));
    this.emitFrame();
    this.trace("setSpm", { input: spm, state: this.state });
  }

  setLoop(enabled: boolean): void {
    this.state.loop = enabled;
    this.emitFrame();
    this.trace("setLoop", { enabled, state: this.state });
  }

  setFrameRate(fps: number): void {
    const clampedFps = Math.max(1, Math.min(120, Math.round(fps)));
    this.frameIntervalMs = Math.max(1, Math.round(1000 / clampedFps));
    if (this.state.isPlaying) {
      this.stopTimer();
      this.startTimer();
    }
    this.trace("setFrameRate", { input: fps, frameIntervalMs: this.frameIntervalMs });
  }

  setBlackout(enabled: boolean): void {
    this.state.isBlackout = enabled;
    this.emitFrame();
    this.trace("setBlackout", { enabled, state: this.state });
  }

  setLayerAValue(fixtureId: string, featureId: string, value: FeatureValue): void {
    const key = frameKey(fixtureId, featureId);
    const normalized = asArray(value).map((item) => clampChannel(item));
    if (isZeroValue(normalized)) {
      delete this.layerAValues[key];
    } else {
      this.layerAValues[key] = normalized;
    }
    this.emitFrame();
    this.trace("setLayerAValue", { key, value: this.layerAValues[key] ?? [0] });
  }

  clearLayerAFeature(fixtureId: string, featureId: string): void {
    const key = frameKey(fixtureId, featureId);
    if (!(key in this.layerAValues)) return;
    delete this.layerAValues[key];
    this.emitFrame();
    this.trace("clearLayerAFeature", { key });
  }

  clearLayerAFixture(fixtureId: string): void {
    let changed = false;
    const prefix = `${fixtureId}:`;
    for (const key of Object.keys(this.layerAValues)) {
      if (!key.startsWith(prefix)) continue;
      delete this.layerAValues[key];
      changed = true;
    }
    if (!changed) return;
    this.emitFrame();
    this.trace("clearLayerAFixture", { fixtureId });
  }

  applyStateSnapshot(snapshot: Pick<
    PlayheadState,
    "stepIndex" | "positionMs" | "spm" | "loop" | "isBlackout" | "isPlaying"
  >): void {
    if (!this.activeProgram) return;
    this.trace("applyStateSnapshot:begin", { snapshot, prevState: this.state });
    const maxStepIndex = Math.max(0, this.activeProgram.steps.length - 1);
    const stepIndex = Math.max(0, Math.min(maxStepIndex, Math.floor(snapshot.stepIndex)));
    this.ensureProgramStep(stepIndex);

    this.state.stepIndex = stepIndex;
    this.state.positionMs = Math.max(0, snapshot.positionMs);
    this.state.spm = Math.max(1, Math.min(500, Math.round(snapshot.spm)));
    this.state.loop = Boolean(snapshot.loop);
    this.state.isBlackout = Boolean(snapshot.isBlackout);
    this.state.isPlaying = Boolean(snapshot.isPlaying);

    if (this.state.isPlaying) {
      this.startTimer();
    } else {
      this.stopTimer();
    }

    this.emitFrame();
    this.trace("applyStateSnapshot:end", { state: this.state });
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
    this.trace("startTimer", { frameIntervalMs: this.frameIntervalMs });
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.lastTickAtMs = null;
    this.trace("stopTimer");
  }

  private tick(): void {
    if (!this.activeProgram || !this.state.isPlaying) return;
    this.trace("tick:begin", { state: this.state });
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
    this.trace("tick:end", { state: this.state });
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
    this.trace("emitFrame", {
      state: frame.state,
      valueKeys: Object.keys(frame.values),
      values: frame.values,
    });
    for (const listener of this.listeners) {
      listener(frame);
    }
  }

  private buildFrame(): SequencerFrame {
    if (!this.activeProgram || this.activeProgram.steps.length === 0) {
      const layerAValues = cloneLayerValues(this.layerAValues);
      return {
        timestamp: Date.now(),
        values: layerAValues,
        layerAValues,
        layerBValues: {},
        state: { ...this.state },
      };
    }

    const steps = this.activeProgram.steps;
    const currentStep = steps[this.state.stepIndex];
    const atProgramStartBoundary = this.state.stepIndex === 0 && this.state.positionMs <= 0;
    const useLoopedPrevious = this.state.loop && !(this.state.isPlaying && atProgramStartBoundary);
    const previousIndex = this.state.stepIndex > 0
      ? this.state.stepIndex - 1
      : useLoopedPrevious
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

    const layerBValues: LayerValueMap = {};
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

      if (!isZeroValue(out)) layerBValues[key] = out;
    }

    const layerAValues = cloneLayerValues(this.layerAValues);
    const values = addLayerValues(layerAValues, layerBValues);

    return {
      timestamp: Date.now(),
      values,
      layerAValues,
      layerBValues,
      state: { ...this.state },
    };
  }

  private trace(event: string, payload?: unknown): void {
    if (!this.debug) return;
    console.info("[sequencer-debug]", event, payload ?? "");
  }
}
