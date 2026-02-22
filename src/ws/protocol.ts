import type { EnvironmentDefinition, FixtureDefinition, ProgramDefinition } from "../config/types.js";
import type { SequencerFrame } from "../core/sequencer.js";

export type ConfigPayload = {
  fixtures: FixtureDefinition[];
  environments: EnvironmentDefinition[];
};

export type ServerEvent =
  | { type: "programs"; payload: ProgramDefinition[] }
  | { type: "config"; payload: ConfigPayload }
  | { type: "frame"; payload: SequencerFrame };

export type ClientEvent =
  | { type: "play" }
  | { type: "pause" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "seek"; payload: { stepIndex: number } }
  | { type: "blackout"; payload: { enabled: boolean } }
  | { type: "tempo"; payload: { spm: number } }
  | { type: "loop"; payload: { enabled: boolean } }
  | { type: "program"; payload: { programId: string } };
