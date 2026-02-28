import type { FeatureValue, PlayheadState, ProgramDefinition } from "../config/types.js";
import { performance } from "node:perf_hooks";

type LayerValueMap = Record<string, number[]>;
type VisibleMixMode = "static" | "sequencer";
type MixTransition = {
  startedAtMs: number;
  fromValues: LayerValueMap;
  toMode: VisibleMixMode;
};

const MODE_SWITCH_FADE_MS = 500;

export type LayerAOperation =
  | { kind: "set"; fixtureId: string; featureId: string; value: FeatureValue }
  | { kind: "clearFeature"; fixtureId: string; featureId: string }
  | { kind: "clearFixture"; fixtureId: string };

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

function valuesEqual(left: number[] | undefined, right: number[]): boolean {
  if (!left) return false;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function cloneLayerValues(values: LayerValueMap): LayerValueMap {
  const clone: LayerValueMap = {};
  for (const [key, entry] of Object.entries(values)) {
    clone[key] = [...entry];
  }
  return clone;
}

function interpolateLayerValues(fromValues: LayerValueMap, toValues: LayerValueMap, ratio: number): LayerValueMap {
  const combined: LayerValueMap = {};
  const keys = new Set([...Object.keys(fromValues), ...Object.keys(toValues)]);
  for (const key of keys) {
    const from = fromValues[key] ?? [0];
    const to = toValues[key] ?? [0];
    const length = Math.max(from.length, to.length);
    const out: number[] = [];
    for (let i = 0; i < length; i += 1) {
      const fromValue = from[i] ?? from[0] ?? 0;
      const toValue = to[i] ?? to[0] ?? 0;
      out.push(clampChannel(fromValue + (toValue - fromValue) * ratio));
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
  private mixTimer: NodeJS.Timeout | null = null;
  private frameIntervalMs = 33;
  private lastTickAtMs: number | null = null;
  private listeners = new Set<(frame: SequencerFrame) => void>();
  private activeProgram: ProgramDefinition | null = null;
  private layerAValues: LayerValueMap = {};
  private mixTransition: MixTransition | null = null;
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
    const fromValues = this.captureVisibleValues();
    this.state.stepIndex = 0;
    this.state.positionMs = 0;
    this.state.isPlaying = true;
    this.beginModeTransition("sequencer", fromValues);
    this.emitFrame();
    this.startTimer();
    this.trace("play", { state: this.state });
  }

  resume(): void {
    if (!this.activeProgram) return;
    if (this.state.isPlaying) return;
    const fromValues = this.captureVisibleValues();
    this.state.isPlaying = true;
    this.beginModeTransition("sequencer", fromValues);
    this.emitFrame();
    this.startTimer();
    this.trace("resume", { state: this.state });
  }

  pause(): void {
    const fromValues = this.captureVisibleValues();
    this.state.isPlaying = false;
    this.stopTimer();
    this.beginModeTransition("static", fromValues);
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
    } else if (this.mixTransition) {
      this.stopMixTimer();
      this.startMixTimer();
    }
    this.trace("setFrameRate", { input: fps, frameIntervalMs: this.frameIntervalMs });
  }

  setBlackout(enabled: boolean): void {
    this.state.isBlackout = enabled;
    this.emitFrame();
    this.trace("setBlackout", { enabled, state: this.state });
  }

  setLayerAValue(fixtureId: string, featureId: string, value: FeatureValue): void {
    const fromValues = this.getVisibleMixMode() === "static" ? this.captureVisibleValues() : null;
    const key = frameKey(fixtureId, featureId);
    const changed = this.setLayerAKey(key, value);
    if (!changed) return;
    if (fromValues) this.beginModeTransition("static", fromValues);
    this.emitFrame();
    this.trace("setLayerAValue", { key, value: this.layerAValues[key] ?? [0] });
  }

  clearLayerAFeature(fixtureId: string, featureId: string): void {
    const fromValues = this.getVisibleMixMode() === "static" ? this.captureVisibleValues() : null;
    const key = frameKey(fixtureId, featureId);
    const changed = this.clearLayerAKey(key);
    if (!changed) return;
    if (fromValues) this.beginModeTransition("static", fromValues);
    this.emitFrame();
    this.trace("clearLayerAFeature", { key });
  }

  clearLayerAFixture(fixtureId: string): void {
    const fromValues = this.getVisibleMixMode() === "static" ? this.captureVisibleValues() : null;
    const changed = this.clearLayerAFixtureKeys(fixtureId);
    if (!changed) return;
    if (fromValues) this.beginModeTransition("static", fromValues);
    this.emitFrame();
    this.trace("clearLayerAFixture", { fixtureId });
  }

  applyLayerABatch(operations: LayerAOperation[]): void {
    if (operations.length === 0) return;
    const fromValues = this.getVisibleMixMode() === "static" ? this.captureVisibleValues() : null;
    let changed = false;
    for (const operation of operations) {
      switch (operation.kind) {
        case "set":
          changed = this.setLayerAKey(frameKey(operation.fixtureId, operation.featureId), operation.value) || changed;
          break;
        case "clearFeature":
          changed = this.clearLayerAKey(frameKey(operation.fixtureId, operation.featureId)) || changed;
          break;
        case "clearFixture":
          changed = this.clearLayerAFixtureKeys(operation.fixtureId) || changed;
          break;
      }
    }
    if (!changed) return;
    if (fromValues) this.beginModeTransition("static", fromValues);
    this.emitFrame();
    this.trace("applyLayerABatch", { operations: operations.length });
  }

  applyStateSnapshot(snapshot: Pick<
    PlayheadState,
    "stepIndex" | "positionMs" | "spm" | "loop" | "isBlackout" | "isPlaying"
  >): void {
    if (!this.activeProgram) return;
    this.trace("applyStateSnapshot:begin", { snapshot, prevState: this.state });
    const previousMode = this.getVisibleMixMode();
    const fromValues = this.captureVisibleValues();
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

    const nextMode = this.getVisibleMixMode();
    if (nextMode !== previousMode) {
      this.beginModeTransition(nextMode, fromValues);
    } else if (!this.state.isPlaying) {
      this.stopMixTimer();
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
    this.stopMixTimer();
    this.trace("startTimer", { frameIntervalMs: this.frameIntervalMs });
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.lastTickAtMs = null;
    this.trace("stopTimer");
  }

  private startMixTimer(): void {
    if (this.state.isPlaying) return;
    if (!this.mixTransition) return;
    if (this.mixTimer) return;
    this.mixTimer = setInterval(() => {
      if (this.state.isPlaying || !this.mixTransition) {
        this.stopMixTimer();
        return;
      }
      this.emitFrame();
    }, this.frameIntervalMs);
    this.trace("startMixTimer", { frameIntervalMs: this.frameIntervalMs });
  }

  private stopMixTimer(): void {
    if (!this.mixTimer) return;
    clearInterval(this.mixTimer);
    this.mixTimer = null;
    this.trace("stopMixTimer");
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
          const fromValues = this.buildSequencerValues();
          this.stopTimer();
          this.beginModeTransition("static", fromValues);
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

  private beginModeTransition(toMode: VisibleMixMode, fromValues: LayerValueMap): void {
    this.mixTransition = {
      startedAtMs: performance.now(),
      fromValues: cloneLayerValues(fromValues),
      toMode,
    };
    if (this.state.isPlaying) {
      this.stopMixTimer();
    } else {
      this.startMixTimer();
    }
    this.trace("beginModeTransition", { toMode, keys: Object.keys(fromValues) });
  }

  private getVisibleMixMode(): VisibleMixMode {
    return this.state.isPlaying && this.activeProgram && this.activeProgram.steps.length > 0 ? "sequencer" : "static";
  }

  private captureVisibleValues(): LayerValueMap {
    const frame = this.buildFrame();
    return cloneLayerValues(frame.values);
  }

  private setLayerAKey(key: string, value: FeatureValue): boolean {
    const normalized = asArray(value).map((item) => clampChannel(item));
    if (isZeroValue(normalized)) {
      return this.clearLayerAKey(key);
    }
    if (valuesEqual(this.layerAValues[key], normalized)) return false;
    this.layerAValues[key] = normalized;
    return true;
  }

  private clearLayerAKey(key: string): boolean {
    if (!(key in this.layerAValues)) return false;
    delete this.layerAValues[key];
    return true;
  }

  private clearLayerAFixtureKeys(fixtureId: string): boolean {
    let changed = false;
    const prefix = `${fixtureId}:`;
    for (const key of Object.keys(this.layerAValues)) {
      if (!key.startsWith(prefix)) continue;
      delete this.layerAValues[key];
      changed = true;
    }
    return changed;
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
    const layerAValues = cloneLayerValues(this.layerAValues);
    const layerBValues = this.buildSequencerValues();
    const targetMode = this.getVisibleMixMode();
    const targetValues = targetMode === "sequencer" ? layerBValues : layerAValues;
    const values = this.buildVisibleValues(targetMode, targetValues);

    return {
      timestamp: Date.now(),
      values,
      layerAValues,
      layerBValues,
      state: { ...this.state },
    };
  }

  private buildSequencerValues(): LayerValueMap {
    if (!this.activeProgram || this.activeProgram.steps.length === 0) {
      return {};
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

    return layerBValues;
  }

  private buildVisibleValues(targetMode: VisibleMixMode, targetValues: LayerValueMap): LayerValueMap {
    const transition = this.mixTransition;
    if (!transition || transition.toMode !== targetMode) {
      return cloneLayerValues(targetValues);
    }

    const progress = clamp01((performance.now() - transition.startedAtMs) / MODE_SWITCH_FADE_MS);
    const values = interpolateLayerValues(transition.fromValues, targetValues, progress);
    if (progress >= 1) {
      this.mixTransition = null;
      this.stopMixTimer();
    }
    return values;
  }

  private trace(event: string, payload?: unknown): void {
    if (!this.debug) return;
    console.info("[sequencer-debug]", event, payload ?? "");
  }
}
