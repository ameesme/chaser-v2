import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProgramDefinition } from "../config/types.js";

export class ProgramStore {
  private programs: ProgramDefinition[];

  constructor(programs: ProgramDefinition[]) {
    this.programs = [...programs];
  }

  list(): ProgramDefinition[] {
    return [...this.programs];
  }

  get(id: string): ProgramDefinition | undefined {
    return this.programs.find((item) => item.id === id);
  }

  async create(program: ProgramDefinition): Promise<ProgramDefinition> {
    if (this.get(program.id)) {
      throw new Error(`Program already exists: ${program.id}`);
    }
    this.programs.push(program);
    await this.persist();
    return program;
  }

  async update(id: string, program: ProgramDefinition): Promise<ProgramDefinition> {
    const index = this.programs.findIndex((item) => item.id === id);
    if (index < 0) {
      throw new Error(`Program not found: ${id}`);
    }
    this.programs[index] = program;
    await this.persist();
    return program;
  }

  async remove(id: string): Promise<void> {
    const before = this.programs.length;
    this.programs = this.programs.filter((item) => item.id !== id);
    if (this.programs.length === before) {
      throw new Error(`Program not found: ${id}`);
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    const fullPath = resolve(process.cwd(), "data/programs.json");
    await writeFile(fullPath, `${JSON.stringify(this.programs, null, 2)}\n`, "utf8");
  }
}
