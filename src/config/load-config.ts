import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  EnvironmentDefinition,
  FixtureDefinition,
  ProgramDefinition,
  RuntimeConfig,
} from "./types.js";

function clampSpm(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 120;
  return Math.max(1, Math.min(500, Math.round(parsed)));
}

function normalizeProgram(program: ProgramDefinition): ProgramDefinition {
  const legacy = program as ProgramDefinition & { tempoBpm?: number };
  const { tempoBpm: _legacyTempoBpm, ...rest } = legacy;
  return {
    ...rest,
    spm: clampSpm(program.spm ?? legacy.tempoBpm ?? 120),
    loop: typeof program.loop === "boolean" ? program.loop : true,
  };
}

async function readJsonFile<T>(relativePath: string): Promise<T> {
  const fullPath = resolve(process.cwd(), relativePath);
  const raw = await readFile(fullPath, "utf8");
  return JSON.parse(raw) as T;
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const [fixtures, environments, programs] = await Promise.all([
    readJsonFile<FixtureDefinition[]>("data/fixtures.json"),
    readJsonFile<EnvironmentDefinition[]>("data/environments.json"),
    readJsonFile<ProgramDefinition[]>("data/programs.json"),
  ]);

  return { fixtures, environments, programs: programs.map(normalizeProgram) };
}
