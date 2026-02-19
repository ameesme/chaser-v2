import type {
  EnvironmentDefinition,
  FixtureDefinition,
  RuntimeConfig,
} from "../config/types.js";
import type { SequencerFrame } from "./sequencer.js";

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
  const environment = config.environments.find((item) => item.id === environmentId);
  if (!environment) return null;

  const dmxByUniverse = new Map<number, Uint8Array>();

  const fixtureById = new Map(environment.fixtures.map((fixture) => [fixture.id, fixture]));
  const fixtureDefs = new Map(config.fixtures.map((fixture) => [fixture.id, fixture]));

  // Always emit full universes with explicit 0 defaults so fixtures don't latch stale values.
  for (const fixture of environment.fixtures) {
    const fixtureDef = fixtureDefs.get(fixture.fixtureTypeId);
    if (!fixtureDef) continue;

    const buffer = dmxByUniverse.get(fixture.universe) ?? new Uint8Array(512);
    for (const featureDef of fixtureDef.features) {
      for (const fixtureChannel of featureDef.channels) {
        const dmxAddress = fixture.address + fixtureChannel - 1;
        if (dmxAddress < 1 || dmxAddress > 512) continue;
        buffer[dmxAddress - 1] = 0;
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
    }

    dmxByUniverse.set(universe, buffer);
  }

  return {
    frame,
    environment,
    dmxByUniverse: Object.fromEntries(dmxByUniverse.entries()),
  };
}

export function fixtureDefinitionByType(
  fixtures: FixtureDefinition[],
  fixtureTypeId: string,
): FixtureDefinition | undefined {
  return fixtures.find((item) => item.id === fixtureTypeId);
}
