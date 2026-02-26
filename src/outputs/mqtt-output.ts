import mqtt from "mqtt";
import type { IClientOptions, MqttClient } from "mqtt";
import type {
  EnvironmentDefinition,
  FixtureDefinition,
  OutputDefinition,
  PlayheadState,
  ProgramDefinition,
  RuntimeConfig,
} from "../config/types.js";
import type { RenderPacket } from "../core/render-packet.js";
import type { Output } from "./output.js";

const DEFAULT_DISCOVERY_PREFIX = "homeassistant";
const DEFAULT_MIN_KELVIN = 2700;
const DEFAULT_MAX_KELVIN = 6500;
const LIGHT_COMMAND_BATCH_MS = 25;

type MqttTarget = Extract<OutputDefinition, { type: "mqtt" }>;

type LayerAControlOperation =
  | { kind: "set"; fixtureId: string; featureId: string; value: number | number[] }
  | { kind: "clearFeature"; fixtureId: string; featureId: string }
  | { kind: "clearFixture"; fixtureId: string };

type MqttControlApi = {
  setLayerAValue: (fixtureId: string, featureId: string, value: number | number[]) => void;
  clearLayerAFeature: (fixtureId: string, featureId: string) => void;
  clearLayerAFixture: (fixtureId: string) => void;
  applyLayerABatch: (operations: LayerAControlOperation[]) => void;
  setSpm: (spm: number) => void;
  setBlackout: (enabled: boolean) => void;
  pause: () => void;
  playFromStart: () => void;
  triggerProgram: (programId: string) => void;
  listPrograms: () => ProgramDefinition[];
};

type LightFixtureMeta = {
  fixtureId: string;
  name: string;
  rgbFeatureId?: string;
  cctFeatureId?: string;
  dimmerFeatureId?: string;
};

type RuntimeTargetState = {
  client: MqttClient;
  environmentId: string;
  outputId: string;
  baseTopic: string;
  discoveryPrefix: string;
  nodeId: string;
  lightMetaByFixtureId: Map<string, LightFixtureMeta>;
  retainedPayloadCache: Map<string, string>;
  subscriptions: Set<string>;
  discoveredProgramIds: Set<string>;
  lightStateByFixtureId: Map<string, FixtureLightState>;
  pendingLightOpsByFixture: Map<string, LayerAControlOperation[]>;
  pendingLightFlushTimer: NodeJS.Timeout | null;
};

type FixtureLightMode = "rgb" | "color_temp" | "brightness";

type FixtureLightState = {
  mode: FixtureLightMode;
  brightness: number;
  baseRgb: [number, number, number];
  baseCct: [number, number];
};

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

function clampSpm(value: number): number {
  if (!Number.isFinite(value)) return 120;
  return Math.max(1, Math.min(500, Math.round(value)));
}

function sanitizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

function toArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map((item) => clampByte(Number(item))) : [clampByte(Number(value))];
}

function parsePayload(raw: Buffer): unknown {
  const text = raw.toString("utf8").trim();
  if (text.length === 0) return "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseOnOff(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "on" || normalized === "true" || normalized === "1") return true;
  if (normalized === "off" || normalized === "false" || normalized === "0") return false;
  return null;
}

function miredToKelvin(mired: number): number {
  if (!Number.isFinite(mired) || mired <= 0) return DEFAULT_MIN_KELVIN;
  return 1_000_000 / mired;
}

function kelvinToMired(kelvin: number): number {
  if (!Number.isFinite(kelvin) || kelvin <= 0) return 370;
  return Math.round(1_000_000 / kelvin);
}

function cctValuesFromKelvin(kelvin: number, brightness: number): [number, number] {
  const safeKelvin = Math.max(DEFAULT_MIN_KELVIN, Math.min(DEFAULT_MAX_KELVIN, kelvin));
  const coolRatio = (safeKelvin - DEFAULT_MIN_KELVIN) / (DEFAULT_MAX_KELVIN - DEFAULT_MIN_KELVIN);
  const warmRatio = 1 - coolRatio;
  return [clampByte(brightness * warmRatio), clampByte(brightness * coolRatio)];
}

function kelvinFromCct(ww: number, cw: number): number {
  const total = ww + cw;
  if (total <= 0) return DEFAULT_MIN_KELVIN;
  const coolRatio = cw / total;
  return Math.round(DEFAULT_MIN_KELVIN + (DEFAULT_MAX_KELVIN - DEFAULT_MIN_KELVIN) * coolRatio);
}

function getBaseTopic(environment: EnvironmentDefinition, target: MqttTarget): string {
  const fallback = `chaser/${sanitizeId(environment.id)}/${sanitizeId(target.id)}`;
  const configured = target.baseTopic?.trim();
  return configured && configured.length > 0 ? configured : fallback;
}

function getDiscoveryPrefix(target: MqttTarget): string {
  const configured = target.discoveryPrefix?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_DISCOVERY_PREFIX;
}

function getNodeId(environment: EnvironmentDefinition, target: MqttTarget): string {
  const configured = target.nodeId?.trim();
  if (configured && configured.length > 0) return sanitizeId(configured);
  return sanitizeId(`chaser_${environment.id}`);
}

function isLightFixture(definition: FixtureDefinition): boolean {
  return definition.features.some((feature) => feature.kind === "rgb" || feature.kind === "cct" || feature.kind === "scalar");
}

function toClientOptions(target: MqttTarget): IClientOptions {
  const options: IClientOptions = {};
  if (target.clientId) options.clientId = target.clientId;
  if (target.username) options.username = target.username;
  if (target.password) options.password = target.password;
  return options;
}

function supportedColorModes(meta: LightFixtureMeta): string[] {
  const modes: string[] = [];
  if (meta.rgbFeatureId) modes.push("rgb");
  if (meta.cctFeatureId) modes.push("color_temp");
  if (modes.length === 0) modes.push("brightness");
  return modes;
}

function scaleValues(base: number[], brightness: number): number[] {
  const scale = clampByte(brightness) / 255;
  return base.map((value) => clampByte(value * scale));
}

function normalizeRgb(values: number[]): [number, number, number] {
  return [
    clampByte(values[0] ?? values[values.length - 1] ?? 0),
    clampByte(values[1] ?? values[values.length - 1] ?? 0),
    clampByte(values[2] ?? values[values.length - 1] ?? 0),
  ];
}

function normalizeCct(values: number[]): [number, number] {
  return [
    clampByte(values[0] ?? values[values.length - 1] ?? 0),
    clampByte(values[1] ?? values[values.length - 1] ?? 0),
  ];
}

export class MqttOutput implements Output {
  readonly id = "mqtt";
  private runtimes = new Map<string, RuntimeTargetState>();
  private fixtureDefsById = new Map<string, FixtureDefinition>();
  private debug = process.env.CHASER_DEBUG === "1";

  constructor(
    private readonly runtimeConfig: RuntimeConfig,
    private readonly controls: MqttControlApi,
  ) {
    for (const fixtureDef of runtimeConfig.fixtures) {
      this.fixtureDefsById.set(fixtureDef.id, fixtureDef);
    }
  }

  push(packet: RenderPacket): void {
    const targets = packet.environment.outputs.filter(
      (output): output is MqttTarget => output.type === "mqtt" && output.enabled,
    );
    if (targets.length === 0) return;

    for (const target of targets) {
      const runtime = this.getRuntime(packet.environment, target);
      this.syncHomeAssistant(packet.environment, target, runtime, packet.frame.state);
      this.publishControlStates(runtime, packet.frame.state);
      this.publishLightStates(runtime, packet.frame.layerAValues ?? {});
      this.publishLegacyPayload(runtime, target, packet);
    }
  }

  private getRuntime(environment: EnvironmentDefinition, target: MqttTarget): RuntimeTargetState {
    const key = `${environment.id}|${target.id}|${target.brokerUrl}`;
    const existing = this.runtimes.get(key);
    if (existing) return existing;

    if (this.debug) {
      console.info("[mqtt-debug] init", {
        environmentId: environment.id,
        outputId: target.id,
        brokerUrl: target.brokerUrl,
        hasUsername: Boolean(target.username),
        hasPassword: Boolean(target.password),
        clientId: target.clientId ?? null,
      });
    }

    const runtime: RuntimeTargetState = {
      client: mqtt.connect(target.brokerUrl, toClientOptions(target)),
      environmentId: environment.id,
      outputId: target.id,
      baseTopic: getBaseTopic(environment, target),
      discoveryPrefix: getDiscoveryPrefix(target),
      nodeId: getNodeId(environment, target),
      lightMetaByFixtureId: this.buildLightMeta(environment),
      retainedPayloadCache: new Map(),
      subscriptions: new Set(),
      discoveredProgramIds: new Set(),
      lightStateByFixtureId: new Map(),
      pendingLightOpsByFixture: new Map(),
      pendingLightFlushTimer: null,
    };

    runtime.client.on("connect", () => {
      for (const topic of runtime.subscriptions) {
        runtime.client.subscribe(topic, { qos: 0 });
      }
      this.publish(runtime, `${runtime.baseTopic}/availability`, "online", true);
      for (const [topic, payload] of runtime.retainedPayloadCache.entries()) {
        runtime.client.publish(topic, payload, { qos: 0, retain: true });
      }
      if (this.debug) {
        console.info("[mqtt-debug] connected", {
          environmentId: runtime.environmentId,
          outputId: runtime.outputId,
          baseTopic: runtime.baseTopic,
          discoveryPrefix: runtime.discoveryPrefix,
        });
      }
    });

    runtime.client.on("close", () => {
      if (this.debug) {
        console.info("[mqtt-debug] disconnected", {
          environmentId: runtime.environmentId,
          outputId: runtime.outputId,
          brokerUrl: target.brokerUrl,
        });
      }
    });

    runtime.client.on("reconnect", () => {
      if (this.debug) {
        console.info("[mqtt-debug] reconnecting", {
          environmentId: runtime.environmentId,
          outputId: runtime.outputId,
          brokerUrl: target.brokerUrl,
        });
      }
    });

    runtime.client.on("offline", () => {
      if (this.debug) {
        console.info("[mqtt-debug] offline", {
          environmentId: runtime.environmentId,
          outputId: runtime.outputId,
          brokerUrl: target.brokerUrl,
        });
      }
    });

    runtime.client.on("message", (topic, payload) => {
      this.handleCommand(runtime, topic, payload);
    });

    runtime.client.on("error", (error) => {
      console.error("[mqtt] client error", {
        environmentId: runtime.environmentId,
        outputId: runtime.outputId,
        brokerUrl: target.brokerUrl,
        message: error.message,
      });
    });

    this.runtimes.set(key, runtime);
    return runtime;
  }

  private buildLightMeta(environment: EnvironmentDefinition): Map<string, LightFixtureMeta> {
    const out = new Map<string, LightFixtureMeta>();
    for (const fixture of environment.fixtures) {
      if (fixture.mqttExpose === false) continue;
      const fixtureDef = this.fixtureDefsById.get(fixture.fixtureTypeId);
      if (!fixtureDef || !isLightFixture(fixtureDef)) continue;
      const rgbFeature = fixtureDef.features.find((feature) => feature.kind === "rgb");
      const cctFeature = fixtureDef.features.find((feature) => feature.kind === "cct");
      const dimmerFeature = fixtureDef.features.find((feature) => feature.kind === "scalar");
      if (!rgbFeature && !cctFeature && !dimmerFeature) continue;
      out.set(fixture.id, {
        fixtureId: fixture.id,
        name: fixture.name,
        rgbFeatureId: rgbFeature?.id,
        cctFeatureId: cctFeature?.id,
        dimmerFeatureId: dimmerFeature?.id,
      });
    }
    return out;
  }

  private syncHomeAssistant(
    environment: EnvironmentDefinition,
    target: MqttTarget,
    runtime: RuntimeTargetState,
    state: PlayheadState,
  ): void {
    const device = {
      identifiers: [runtime.nodeId],
      name: `Chaser ${environment.name}`,
      manufacturer: "chaser-v2",
      model: "Sequencer",
    };

    for (const meta of runtime.lightMetaByFixtureId.values()) {
      const objectId = sanitizeId(`layer_a_${meta.fixtureId}`);
      const discoveryTopic = `${runtime.discoveryPrefix}/light/${runtime.nodeId}/${objectId}/config`;
      const commandTopic = `${runtime.baseTopic}/light/${meta.fixtureId}/set`;
      const stateTopic = `${runtime.baseTopic}/light/${meta.fixtureId}/state`;
      this.subscribe(runtime, commandTopic);

      const payload: Record<string, unknown> = {
        name: meta.name,
        unique_id: `${runtime.nodeId}_${objectId}`,
        schema: "json",
        command_topic: commandTopic,
        state_topic: stateTopic,
        availability_topic: `${runtime.baseTopic}/availability`,
        payload_available: "online",
        payload_not_available: "offline",
        brightness: true,
        supported_color_modes: supportedColorModes(meta),
        device,
      };
      if (meta.rgbFeatureId) payload.rgb = true;
      if (meta.cctFeatureId) {
        payload.color_temp = true;
        payload.min_mireds = kelvinToMired(DEFAULT_MAX_KELVIN);
        payload.max_mireds = kelvinToMired(DEFAULT_MIN_KELVIN);
      }

      this.publishJsonRetained(runtime, discoveryTopic, payload);
    }

    const controlBase = `${runtime.baseTopic}/control`;

    this.subscribe(runtime, `${controlBase}/spm/set`);
    this.publishJsonRetained(
      runtime,
      `${runtime.discoveryPrefix}/number/${runtime.nodeId}/spm/config`,
      {
        name: "SPM",
        unique_id: `${runtime.nodeId}_spm`,
        command_topic: `${controlBase}/spm/set`,
        state_topic: `${controlBase}/spm/state`,
        availability_topic: `${runtime.baseTopic}/availability`,
        payload_available: "online",
        payload_not_available: "offline",
        min: 1,
        max: 500,
        step: 1,
        mode: "box",
        device,
      },
    );

    this.subscribe(runtime, `${controlBase}/play_from_start/press`);
    this.publishJsonRetained(
      runtime,
      `${runtime.discoveryPrefix}/button/${runtime.nodeId}/play_from_start/config`,
      {
        name: "Play From Start",
        unique_id: `${runtime.nodeId}_play_from_start`,
        command_topic: `${controlBase}/play_from_start/press`,
        payload_press: "PRESS",
        availability_topic: `${runtime.baseTopic}/availability`,
        payload_available: "online",
        payload_not_available: "offline",
        device,
      },
    );

    this.subscribe(runtime, `${controlBase}/pause/press`);
    this.publishJsonRetained(
      runtime,
      `${runtime.discoveryPrefix}/button/${runtime.nodeId}/pause/config`,
      {
        name: "Pause",
        unique_id: `${runtime.nodeId}_pause`,
        command_topic: `${controlBase}/pause/press`,
        payload_press: "PRESS",
        availability_topic: `${runtime.baseTopic}/availability`,
        payload_available: "online",
        payload_not_available: "offline",
        device,
      },
    );

    this.subscribe(runtime, `${controlBase}/blackout/set`);
    this.publishJsonRetained(
      runtime,
      `${runtime.discoveryPrefix}/switch/${runtime.nodeId}/blackout/config`,
      {
        name: "Blackout",
        unique_id: `${runtime.nodeId}_blackout`,
        command_topic: `${controlBase}/blackout/set`,
        state_topic: `${controlBase}/blackout/state`,
        payload_on: "ON",
        payload_off: "OFF",
        state_on: "ON",
        state_off: "OFF",
        availability_topic: `${runtime.baseTopic}/availability`,
        payload_available: "online",
        payload_not_available: "offline",
        device,
      },
    );

    const programs = this.controls.listPrograms();
    const currentProgramIds = new Set<string>();
    for (const program of programs) {
      currentProgramIds.add(program.id);
      const objectId = sanitizeId(`program_${program.id}`);
      const commandTopic = `${runtime.baseTopic}/program/${program.id}/press`;
      this.subscribe(runtime, commandTopic);
      this.publishJsonRetained(
        runtime,
        `${runtime.discoveryPrefix}/button/${runtime.nodeId}/${objectId}/config`,
        {
          name: `Program ${program.name}`,
          unique_id: `${runtime.nodeId}_${objectId}`,
          command_topic: commandTopic,
          payload_press: "PRESS",
          availability_topic: `${runtime.baseTopic}/availability`,
          payload_available: "online",
          payload_not_available: "offline",
          device,
        },
      );
    }

    for (const existing of runtime.discoveredProgramIds) {
      if (currentProgramIds.has(existing)) continue;
      const objectId = sanitizeId(`program_${existing}`);
      this.publish(runtime, `${runtime.discoveryPrefix}/button/${runtime.nodeId}/${objectId}/config`, "", true);
    }
    runtime.discoveredProgramIds = currentProgramIds;

    this.publish(runtime, `${runtime.baseTopic}/availability`, "online", true);
    this.publish(runtime, `${controlBase}/blackout/state`, state.isBlackout ? "ON" : "OFF", true);
    this.publish(runtime, `${controlBase}/spm/state`, String(clampSpm(state.spm)), true);
  }

  private publishControlStates(runtime: RuntimeTargetState, state: PlayheadState): void {
    this.publish(runtime, `${runtime.baseTopic}/control/blackout/state`, state.isBlackout ? "ON" : "OFF", true);
    this.publish(runtime, `${runtime.baseTopic}/control/spm/state`, String(clampSpm(state.spm)), true);
  }

  private publishLightStates(
    runtime: RuntimeTargetState,
    layerAValues: Record<string, number[]>,
  ): void {
    for (const meta of runtime.lightMetaByFixtureId.values()) {
      const rgb = meta.rgbFeatureId
        ? normalizeRgb(toArray(layerAValues[`${meta.fixtureId}:${meta.rgbFeatureId}`] ?? [0, 0, 0]))
        : null;
      const cct = meta.cctFeatureId
        ? normalizeCct(toArray(layerAValues[`${meta.fixtureId}:${meta.cctFeatureId}`] ?? [0, 0]))
        : null;
      const dimmer = meta.dimmerFeatureId
        ? clampByte(toArray(layerAValues[`${meta.fixtureId}:${meta.dimmerFeatureId}`] ?? [0])[0] ?? 0)
        : 0;

      const brightnessFromRgb = rgb ? Math.max(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0) : 0;
      const brightnessFromCct = cct ? Math.max(cct[0] ?? 0, cct[1] ?? 0) : 0;
      const hasRgb = Boolean(rgb && brightnessFromRgb > 0 && meta.rgbFeatureId);
      const hasCct = Boolean(cct && brightnessFromCct > 0 && meta.cctFeatureId);
      const previous = runtime.lightStateByFixtureId.get(meta.fixtureId);
      const colorMode: FixtureLightMode = hasRgb
        ? "rgb"
        : hasCct
          ? "color_temp"
          : meta.dimmerFeatureId
            ? "brightness"
            : previous?.mode ?? (supportedColorModes(meta)[0] as FixtureLightMode);

      let brightness = 0;
      if (meta.dimmerFeatureId) {
        brightness = dimmer;
      } else if (colorMode === "rgb") {
        brightness = hasRgb
          ? (previous?.mode === "rgb" && previous.brightness > 0 ? previous.brightness : brightnessFromRgb)
          : 0;
      } else if (colorMode === "color_temp") {
        brightness = hasCct
          ? (previous?.mode === "color_temp" && previous.brightness > 0
            ? previous.brightness
            : brightnessFromCct)
          : 0;
      } else {
        brightness = clampByte(Math.max(dimmer, brightnessFromRgb, brightnessFromCct));
      }
      brightness = clampByte(brightness);

      const nextState: FixtureLightState = previous ?? {
        mode: colorMode,
        brightness: 255,
        baseRgb: [255, 255, 255],
        baseCct: [255, 255],
      };
      nextState.mode = colorMode;
      nextState.brightness = brightness;
      if (rgb && colorMode === "rgb") {
        if (brightness > 0) {
          nextState.baseRgb = normalizeRgb(rgb.map((value) => (value / brightness) * 255));
        } else {
          nextState.baseRgb = previous?.baseRgb ?? rgb;
        }
      }
      if (cct && colorMode === "color_temp") {
        if (brightness > 0) {
          nextState.baseCct = normalizeCct(cct.map((value) => (value / brightness) * 255));
        } else {
          nextState.baseCct = previous?.baseCct ?? cct;
        }
      }
      runtime.lightStateByFixtureId.set(meta.fixtureId, nextState);

      const payload: Record<string, unknown> = {
        state: brightness > 0 ? "ON" : "OFF",
        brightness,
        color_mode: colorMode,
      };
      if (meta.rgbFeatureId && colorMode === "rgb") {
        const [r, g, b] = nextState.baseRgb;
        payload.color = { r: clampByte(r), g: clampByte(g), b: clampByte(b) };
      }
      if (meta.cctFeatureId && colorMode === "color_temp") {
        const kelvin = kelvinFromCct(nextState.baseCct[0] ?? 0, nextState.baseCct[1] ?? 0);
        payload.color_temp = kelvinToMired(kelvin);
      }

      this.publishJsonRetained(runtime, `${runtime.baseTopic}/light/${meta.fixtureId}/state`, payload);
    }
  }

  private publishLegacyPayload(runtime: RuntimeTargetState, target: MqttTarget, packet: RenderPacket): void {
    if (!target.topic) return;
    const payload = {
      timestamp: packet.frame.timestamp,
      state: packet.frame.state,
      values: packet.frame.values,
      layerAValues: packet.frame.layerAValues,
      layerBValues: packet.frame.layerBValues,
      dmxByUniverse: Object.fromEntries(
        Object.entries(packet.dmxByUniverse).map(([universe, data]) => [
          universe,
          Array.from(data),
        ]),
      ),
    };
    this.publishJson(runtime, target.topic, payload);
  }

  private handleCommand(runtime: RuntimeTargetState, topic: string, rawPayload: Buffer): void {
    const payload = parsePayload(rawPayload);
    const controlPrefix = `${runtime.baseTopic}/control/`;
    const programPrefix = `${runtime.baseTopic}/program/`;
    const lightPrefix = `${runtime.baseTopic}/light/`;

    if (topic === `${controlPrefix}spm/set`) {
      const value = Number(typeof payload === "object" && payload && "value" in payload ? (payload as { value: unknown }).value : payload);
      this.controls.setSpm(clampSpm(value));
      return;
    }

    if (topic === `${controlPrefix}play_from_start/press`) {
      this.controls.playFromStart();
      return;
    }

    if (topic === `${controlPrefix}pause/press`) {
      this.controls.pause();
      return;
    }

    if (topic === `${controlPrefix}blackout/set`) {
      let flag = parseOnOff(payload);
      if (flag === null && typeof payload === "object" && payload && "state" in payload) {
        flag = parseOnOff((payload as { state: unknown }).state);
      }
      if (flag !== null) {
        this.controls.setBlackout(flag);
      }
      return;
    }

    if (topic.startsWith(`${programPrefix}`) && topic.endsWith("/press")) {
      const programId = topic.slice(programPrefix.length, -"/press".length);
      if (programId) this.controls.triggerProgram(programId);
      return;
    }

    if (topic.startsWith(`${lightPrefix}`) && topic.endsWith("/set")) {
      const fixtureId = topic.slice(lightPrefix.length, -"/set".length);
      if (!fixtureId) return;
      this.handleLightCommand(runtime, fixtureId, payload);
    }
  }

  private handleLightCommand(runtime: RuntimeTargetState, fixtureId: string, payload: unknown): void {
    const operations = this.buildLightOperations(runtime, fixtureId, payload);
    if (operations.length === 0) return;
    runtime.pendingLightOpsByFixture.set(fixtureId, operations);
    this.scheduleLightBatchFlush(runtime);
  }

  private buildLightOperations(
    runtime: RuntimeTargetState,
    fixtureId: string,
    payload: unknown,
  ): LayerAControlOperation[] {
    const meta = runtime.lightMetaByFixtureId.get(fixtureId);
    if (!meta) return [];

    const objectPayload =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : {};
    const directState = parseOnOff(payload);
    const state = parseOnOff(objectPayload.state) ?? directState;
    if (state === false) {
      const previous = runtime.lightStateByFixtureId.get(fixtureId);
      if (previous) {
        previous.brightness = 0;
        runtime.lightStateByFixtureId.set(fixtureId, previous);
      }
      return [{ kind: "clearFixture", fixtureId }];
    }

    const previous = runtime.lightStateByFixtureId.get(fixtureId) ?? {
      mode: meta.rgbFeatureId ? "rgb" : meta.cctFeatureId ? "color_temp" : "brightness",
      brightness: 255,
      baseRgb: [255, 255, 255] as [number, number, number],
      baseCct: [255, 255] as [number, number],
    };
    const hasBrightnessInput = Number.isFinite(Number(objectPayload.brightness));
    const brightness = hasBrightnessInput
      ? clampByte(Number(objectPayload.brightness))
      : (state === true ? (previous.brightness || 255) : previous.brightness);

    let mode: FixtureLightMode = previous.mode;
    const color = objectPayload.color;
    if (
      meta.rgbFeatureId
      && typeof color === "object"
      && color !== null
      && "r" in color
      && "g" in color
      && "b" in color
    ) {
      previous.baseRgb = normalizeRgb([
        Number((color as Record<string, unknown>).r),
        Number((color as Record<string, unknown>).g),
        Number((color as Record<string, unknown>).b),
      ]);
      mode = "rgb";
    }

    const rawColorTemp = Number(objectPayload.color_temp ?? NaN);
    if (meta.cctFeatureId && Number.isFinite(rawColorTemp) && rawColorTemp > 0) {
      const kelvin = miredToKelvin(rawColorTemp);
      previous.baseCct = cctValuesFromKelvin(kelvin, 255);
      mode = "color_temp";
    }

    previous.mode = mode;
    previous.brightness = brightness;

    if (mode === "rgb" && meta.rgbFeatureId) {
      const rgb = normalizeRgb(scaleValues(previous.baseRgb, brightness));
      const operations: LayerAControlOperation[] = [
        { kind: "set", fixtureId, featureId: meta.rgbFeatureId, value: rgb },
      ];
      if (meta.cctFeatureId) {
        operations.push({ kind: "clearFeature", fixtureId, featureId: meta.cctFeatureId });
      }
      if (meta.dimmerFeatureId) {
        operations.push({ kind: "clearFeature", fixtureId, featureId: meta.dimmerFeatureId });
      }
      runtime.lightStateByFixtureId.set(fixtureId, previous);
      return operations;
    }

    if (mode === "color_temp" && meta.cctFeatureId) {
      const cct = normalizeCct(scaleValues(previous.baseCct, brightness));
      const operations: LayerAControlOperation[] = [
        { kind: "set", fixtureId, featureId: meta.cctFeatureId, value: cct },
      ];
      if (meta.rgbFeatureId) {
        operations.push({ kind: "clearFeature", fixtureId, featureId: meta.rgbFeatureId });
      }
      if (meta.dimmerFeatureId) {
        operations.push({ kind: "clearFeature", fixtureId, featureId: meta.dimmerFeatureId });
      }
      runtime.lightStateByFixtureId.set(fixtureId, previous);
      return operations;
    }

    if (meta.dimmerFeatureId) {
      runtime.lightStateByFixtureId.set(fixtureId, previous);
      return [{ kind: "set", fixtureId, featureId: meta.dimmerFeatureId, value: brightness }];
    }

    if (meta.cctFeatureId) {
      const cct = normalizeCct(scaleValues(previous.baseCct, brightness));
      runtime.lightStateByFixtureId.set(fixtureId, previous);
      return [{ kind: "set", fixtureId, featureId: meta.cctFeatureId, value: cct }];
    }

    if (meta.rgbFeatureId) {
      const rgb = normalizeRgb(scaleValues(previous.baseRgb, brightness));
      runtime.lightStateByFixtureId.set(fixtureId, previous);
      return [{ kind: "set", fixtureId, featureId: meta.rgbFeatureId, value: rgb }];
    }
    return [];
  }

  private scheduleLightBatchFlush(runtime: RuntimeTargetState): void {
    if (runtime.pendingLightFlushTimer) return;
    runtime.pendingLightFlushTimer = setTimeout(() => {
      runtime.pendingLightFlushTimer = null;
      this.flushLightBatch(runtime);
    }, LIGHT_COMMAND_BATCH_MS);
  }

  private flushLightBatch(runtime: RuntimeTargetState): void {
    if (runtime.pendingLightOpsByFixture.size === 0) return;
    const operations = [...runtime.pendingLightOpsByFixture.values()].flat();
    runtime.pendingLightOpsByFixture.clear();
    if (operations.length === 0) return;
    this.controls.applyLayerABatch(operations);
    if (this.debug) {
      const fixtureCount = new Set(operations.map((operation) => operation.fixtureId)).size;
      console.info("[mqtt-debug] light batch flush", {
        fixtures: fixtureCount,
        operations: operations.length,
      });
    }
  }

  private subscribe(runtime: RuntimeTargetState, topic: string): void {
    if (runtime.subscriptions.has(topic)) return;
    runtime.subscriptions.add(topic);
    runtime.client.subscribe(topic, { qos: 0 });
  }

  private publishJson(runtime: RuntimeTargetState, topic: string, payload: unknown): void {
    this.publish(runtime, topic, JSON.stringify(payload), false);
  }

  private publishJsonRetained(runtime: RuntimeTargetState, topic: string, payload: unknown): void {
    const serialized = JSON.stringify(payload);
    const previous = runtime.retainedPayloadCache.get(topic);
    if (previous === serialized) return;
    runtime.retainedPayloadCache.set(topic, serialized);
    this.publish(runtime, topic, serialized, true);
  }

  private publish(
    runtime: RuntimeTargetState,
    topic: string,
    payload: string,
    retain: boolean,
  ): void {
    if (!runtime.client.connected) return;
    runtime.client.publish(topic, payload, { qos: 0, retain });
  }
}
