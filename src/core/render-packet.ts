import type {
  EnvironmentDefinition,
  FixtureDefinition,
  RuntimeConfig,
} from "../config/types.js";
import type { SequencerFrame } from "./sequencer.js";

const debug = process.env.CHASER_DEBUG === "1";

export type RenderPacket = {
  frame: SequencerFrame;
  environment: EnvironmentDefinition;
  dmxByUniverse: Record<number, Uint8Array>;
};

function clampDmx(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return Math.round(value);
}

export function buildRenderPacket(
  frame: SequencerFrame,
  config: RuntimeConfig,
  environmentId: string,
): RenderPacket | null {
  if (debug) {
    console.info("[render-debug] build:start", {
      environmentId,
      stepIndex: frame.state.stepIndex,
      valueKeys: Object.keys(frame.values),
      values: frame.values,
    });
  }
  const environment = config.environments.find((item) => item.id === environmentId);
  if (!environment) return null;

  const dmxByUniverse = new Map<number, Uint8Array>();

  const fixtureById = new Map(environment.fixtures.map((fixture) => [fixture.id, fixture]));
  const fixtureDefs = new Map(config.fixtures.map((fixture) => [fixture.id, fixture]));

  // Always emit full fixture footprints with explicit 0 defaults so fixtures
  // don't latch stale values on channels outside modeled feature groups.
  for (const fixture of environment.fixtures) {
    const fixtureDef = fixtureDefs.get(fixture.fixtureTypeId);
    if (!fixtureDef) continue;

    const buffer = dmxByUniverse.get(fixture.universe) ?? new Uint8Array(512);
    for (let fixtureChannel = 1; fixtureChannel <= fixtureDef.channels; fixtureChannel += 1) {
      const dmxAddress = fixture.address + fixtureChannel - 1;
      if (dmxAddress < 1 || dmxAddress > 512) continue;
      buffer[dmxAddress - 1] = 0;
      if (debug) {
        console.info("[render-debug] zero", {
          fixtureId: fixture.id,
          fixtureName: fixture.name,
          universe: fixture.universe,
          fixtureChannel,
          dmxAddress,
        });
      }
    }
    dmxByUniverse.set(fixture.universe, buffer);
  }

  for (const [key, values] of Object.entries(frame.values)) {
    const [fixtureId, featureId] = key.split(":");
    const fixture = fixtureById.get(fixtureId);
    if (!fixture) continue;

    const fixtureDef = fixtureDefs.get(fixture.fixtureTypeId);
    if (!fixtureDef) continue;

    const featureDef = fixtureDef.features.find((feature) => feature.id === featureId);
    if (!featureDef) continue;

    const universe = fixture.universe;
    const buffer = dmxByUniverse.get(universe) ?? new Uint8Array(512);

    for (let i = 0; i < featureDef.channels.length; i += 1) {
      const fixtureChannel = featureDef.channels[i];
      const rawValue = values[i] ?? values[0] ?? 0;
      const normalized = Math.max(0, Math.min(255, rawValue));
      const min = featureDef.range?.min ?? 0;
      const max = featureDef.range?.max ?? 255;
      const shouldScaleFrom255 = min === 0 && max > 0 && max < 255;
      const value = shouldScaleFrom255
        ? (normalized / 255) * max
        : Math.max(min, Math.min(max, normalized));
      const dmxAddress = fixture.address + fixtureChannel - 1;
      if (dmxAddress < 1 || dmxAddress > 512) continue;
      buffer[dmxAddress - 1] = clampDmx(value);
      if (debug) {
        console.info("[render-debug] write", {
          key,
          fixtureId,
          fixtureName: fixture.name,
          featureId,
          universe,
          fixtureChannel,
          dmxAddress,
          rawValue,
          normalized,
          min,
          max,
          output: clampDmx(value),
        });
      }
    }

    dmxByUniverse.set(universe, buffer);
  }

  const out = {
    frame,
    environment,
    dmxByUniverse: Object.fromEntries(dmxByUniverse.entries()),
  };
  if (debug) {
    const summary = Object.entries(out.dmxByUniverse).map(([universe, dmx]) => {
      const nonZero: Array<{ address: number; value: number }> = [];
      for (let i = 0; i < dmx.length; i += 1) {
        if (dmx[i] > 0) nonZero.push({ address: i + 1, value: dmx[i] });
      }
      return { universe: Number(universe), nonZeroCount: nonZero.length, nonZero };
    });
    console.info("[render-debug] build:end", { summary });
  }
  return out;
}

export function fixtureDefinitionByType(
  fixtures: FixtureDefinition[],
  fixtureTypeId: string,
): FixtureDefinition | undefined {
  return fixtures.find((item) => item.id === fixtureTypeId);
}
