export type UUID = string;

export type ChannelRange = {
  min: number;
  max: number;
};

export type FeatureKind = "scalar" | "rgb" | "cct";

export type FixtureFeature = {
  id: string;
  label: string;
  channels: number[];
  kind: FeatureKind;
  range?: ChannelRange;
};

export type FixtureDefinition = {
  id: string;
  name: string;
  brand: string;
  dimensionsMm: { width: number; height: number; depth: number };
  channels: number;
  dimmerColorRgb?: [number, number, number];
  features: FixtureFeature[];
};

export type EnvironmentFixture = {
  id: string;
  fixtureTypeId: string;
  name: string;
  universe: number;
  address: number;
  position2d: { x: number; y: number };
  orientationDeg?: number;
};

export type OutputDefinition =
  | {
      id: string;
      type: "simulator";
      enabled: boolean;
    }
  | {
      id: string;
      type: "artnet";
      enabled: boolean;
      host: string;
      port: number;
      universes?: number[];
    }
  | {
      id: string;
      type: "mqtt";
      enabled: boolean;
      brokerUrl: string;
      topic: string;
    };

export type EnvironmentDefinition = {
  id: string;
  name: string;
  dimensionsMm: { width: number; height: number };
  renderFps?: number;
  fixtures: EnvironmentFixture[];
  outputs: OutputDefinition[];
};

export type FeatureValue = number | number[];

export type FeatureFrame = {
  fixtureId: string;
  featureId: string;
  value: FeatureValue;
};

export type ProgramStep = {
  id: string;
  durationMs: number;
  fadeMs: number;
  frames: FeatureFrame[];
};

export type ProgramDefinition = {
  id: UUID;
  name: string;
  environmentId: string;
  spm: number;
  loop: boolean;
  steps: ProgramStep[];
};

export type PlayheadState = {
  isPlaying: boolean;
  isBlackout: boolean;
  programId: UUID | null;
  stepIndex: number;
  positionMs: number;
  spm: number;
  loop: boolean;
};

export type RuntimeConfig = {
  fixtures: FixtureDefinition[];
  environments: EnvironmentDefinition[];
  programs: ProgramDefinition[];
};
