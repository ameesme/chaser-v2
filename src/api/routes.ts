import type { FastifyInstance } from "fastify";
import type { ProgramStore } from "../core/program-store.js";
import type { Sequencer } from "../core/sequencer.js";
import type { WsHub } from "../ws/hub.js";
import type { ProgramDefinition, RuntimeConfig } from "../config/types.js";

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

function validateProgram(program: ProgramDefinition, config: RuntimeConfig): string | null {
  const environment = config.environments.find((item) => item.id === program.environmentId);
  if (!environment) return `Unknown environment: ${program.environmentId}`;
  if (program.steps.length === 0) return "Program requires at least one step";
  if (!Number.isFinite(program.spm) || program.spm < 1 || program.spm > 500) {
    return "Program SPM must be between 1 and 500";
  }
  if (typeof program.loop !== "boolean") {
    return "Program loop must be a boolean";
  }

  const fixtureById = new Map(environment.fixtures.map((item) => [item.id, item]));
  const fixtureDefs = new Map(config.fixtures.map((item) => [item.id, item]));

  for (const step of program.steps) {
    if (step.durationMs <= 0) return `Step ${step.id} must have positive duration`;
    if (step.fadeMs < 0) return `Step ${step.id} cannot have negative fade`;

    for (const frame of step.frames) {
      const environmentFixture = fixtureById.get(frame.fixtureId);
      if (!environmentFixture) {
        return `Step ${step.id} references missing fixture ${frame.fixtureId}`;
      }
      const fixtureDef = fixtureDefs.get(environmentFixture.fixtureTypeId);
      if (!fixtureDef) {
        return `Fixture definition not found for ${environmentFixture.fixtureTypeId}`;
      }
      const feature = fixtureDef.features.find((item) => item.id === frame.featureId);
      if (!feature) {
        return `Step ${step.id} references missing feature ${frame.featureId} on ${frame.fixtureId}`;
      }
      const expectedChannels = feature.channels.length;
      const values = Array.isArray(frame.value) ? frame.value : [frame.value];
      if (values.length !== expectedChannels) {
        return `Step ${step.id} ${frame.fixtureId}:${frame.featureId} expected ${expectedChannels} values`;
      }
    }
  }

  return null;
}

export async function registerRoutes(
  app: FastifyInstance,
  deps: {
    config: RuntimeConfig;
    programStore: ProgramStore;
    sequencer: Sequencer;
    wsHub: WsHub;
  },
): Promise<void> {
  const debug = process.env.CHASER_DEBUG === "1";

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/config", async () => ({
    fixtures: deps.config.fixtures,
    environments: deps.config.environments,
  }));

  app.get("/api/programs", async () => deps.programStore.list());

  app.post<{ Body: ProgramDefinition }>("/api/programs", async (request, reply) => {
    try {
      const validationError = validateProgram(request.body, deps.config);
      if (validationError) {
        reply.code(400);
        return { error: validationError };
      }

      const created = await deps.programStore.create(request.body);
      deps.wsHub.broadcast({ type: "programs", payload: deps.programStore.list() });
      reply.code(201);
      return created;
    } catch (error) {
      reply.code(400);
      return { error: asErrorMessage(error) };
    }
  });

  app.put<{ Params: { id: string }; Body: ProgramDefinition }>(
    "/api/programs/:id",
    async (request, reply) => {
      try {
        const validationError = validateProgram(request.body, deps.config);
        if (validationError) {
          reply.code(400);
          return { error: validationError };
        }
        if (debug) {
          const totalFrames = request.body.steps.reduce((sum, step) => sum + step.frames.length, 0);
          const stepFrameCounts = request.body.steps.map((step, index) => ({
            index,
            id: step.id,
            frames: step.frames.length,
          }));
          app.log.info(
            {
              tag: "sync-debug",
              phase: "put-request-body",
              programId: request.body.id,
              totalFrames,
              stepFrameCounts,
            },
            "Received program update payload",
          );
        }

        const updated = await deps.programStore.update(request.params.id, request.body);
        if (deps.sequencer.getProgramId() === updated.id) {
          const currentState = deps.sequencer.getState();
          if (debug) {
            app.log.info(
              {
                tag: "sync-debug",
                phase: "before-active-program-update",
                programId: updated.id,
                stepIndex: currentState.stepIndex,
                isPlaying: currentState.isPlaying,
                positionMs: currentState.positionMs,
                updatedSteps: updated.steps.length,
              },
              "Applying active program update",
            );
          }
          deps.sequencer.setProgram(updated, { preservePlayhead: true, suppressEmit: true });
          const environment = deps.config.environments.find(
            (item) => item.id === updated.environmentId,
          );
          deps.sequencer.setFrameRate(environment?.renderFps ?? 30);
          deps.sequencer.applyStateSnapshot(currentState);
          if (debug) {
            const afterState = deps.sequencer.getState();
            app.log.info(
              {
                tag: "sync-debug",
                phase: "after-active-program-update",
                programId: updated.id,
                stepIndex: afterState.stepIndex,
                isPlaying: afterState.isPlaying,
                positionMs: afterState.positionMs,
                spm: afterState.spm,
                loop: afterState.loop,
                blackout: afterState.isBlackout,
              },
              "Active program update applied",
            );
          }
        }
        deps.wsHub.broadcast({ type: "programs", payload: deps.programStore.list() });
        return updated;
      } catch (error) {
        reply.code(404);
        return { error: asErrorMessage(error) };
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/programs/:id", async (request, reply) => {
    try {
      await deps.programStore.remove(request.params.id);
      deps.wsHub.broadcast({ type: "programs", payload: deps.programStore.list() });
      reply.code(204);
      return null;
    } catch (error) {
      reply.code(404);
      return { error: asErrorMessage(error) };
    }
  });

  app.get("/api/state", async () => deps.sequencer.getState());

  app.post<{
    Body: {
      action: string;
      spm?: number;
      enabled?: boolean;
      programId?: string;
      stepIndex?: number;
    };
  }>("/api/control", async (request, reply) => {
    const { action } = request.body;
    switch (action) {
      case "play":
        deps.sequencer.play();
        break;
      case "pause":
        deps.sequencer.pause();
        break;
      case "next":
        deps.sequencer.nextStep();
        break;
      case "previous":
        deps.sequencer.previousStep();
        break;
      case "seek":
        deps.sequencer.setStep(request.body.stepIndex ?? 0);
        break;
      case "tempo":
        deps.sequencer.setSpm(request.body.spm ?? 120);
        break;
      case "loop":
        deps.sequencer.setLoop(Boolean(request.body.enabled));
        break;
      case "blackout":
        deps.sequencer.setBlackout(Boolean(request.body.enabled));
        break;
      case "program": {
        const program = deps.programStore.get(request.body.programId ?? "");
        if (!program) {
          reply.code(404);
          return { error: "Program not found" };
        }
        deps.sequencer.setProgram(program);
        const environment = deps.config.environments.find(
          (item) => item.id === program.environmentId,
        );
        deps.sequencer.setFrameRate(environment?.renderFps ?? 30);
        break;
      }
      default:
        reply.code(400);
        return { error: `Unknown action: ${action}` };
    }

    const state = deps.sequencer.getState();
    deps.wsHub.broadcast({ type: "state", payload: state });
    return state;
  });
}
