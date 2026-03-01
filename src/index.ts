import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import staticPlugin from "@fastify/static";
import { loadRuntimeConfig } from "./config/load-config.js";
import { ProgramStore } from "./core/program-store.js";
import { Sequencer } from "./core/sequencer.js";
import { Renderer } from "./core/renderer.js";
import { buildRenderPacket } from "./core/render-packet.js";
import { ArtnetOutput } from "./outputs/artnet-output.js";
import { MqttOutput } from "./outputs/mqtt-output.js";
import { registerRoutes } from "./api/routes.js";
import { WsHub } from "./ws/hub.js";
import type { ClientEvent, ServerEvent } from "./ws/protocol.js";
import type { RuntimeConfig } from "./config/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type WebSocketLike = {
  send: (payload: string) => void;
};

type ConnectionLike = { socket: WebSocketLike } | WebSocketLike;

function connectionSocket(connection: ConnectionLike): WebSocketLike {
  return "socket" in connection ? connection.socket : connection;
}

function applyDefaultStaticPanelValues(config: RuntimeConfig, sequencer: Sequencer): void {
  const panelFixtureType = config.fixtures.find((fixture) => fixture.id === "fixture-rgbcct-5ch");
  const cctFeatureId = panelFixtureType?.features.find((feature) => feature.kind === "cct")?.id;
  if (!cctFeatureId) return;

  const environment = config.environments.find((item) => item.id === "env-studio-a");
  if (!environment) return;

  const panelOperations = environment.fixtures
    .filter((fixture) => fixture.fixtureTypeId === "fixture-rgbcct-5ch")
    .map((fixture) => ({
      kind: "set" as const,
      fixtureId: fixture.id,
      featureId: cctFeatureId,
      value: [128, 128],
    }));

  if (panelOperations.length === 0) return;
  sequencer.applyLayerABatch(panelOperations);
}

async function buildServer() {
  const config = await loadRuntimeConfig();
  const debug = process.env.CHASER_DEBUG === "1";

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(websocket);
  await app.register(staticPlugin, {
    root: resolve(__dirname, "..", "public"),
  });

  const programStore = new ProgramStore(config.programs);
  const sequencer = new Sequencer();
  const wsHub = new WsHub();

  const applyProgram = (programId: string): void => {
    const program = programStore.get(programId);
    if (!program) return;
    const currentState = sequencer.getState();
    const preserveTransport = currentState.isPlaying && currentState.stepIndex < program.steps.length;
    sequencer.setProgram(program, {
      preservePlayhead: preserveTransport,
      preserveTempo: true,
    });
    const environment = config.environments.find((item) => item.id === program.environmentId);
    sequencer.setFrameRate(environment?.renderFps ?? 30);
  };

  const renderer = new Renderer([
    new ArtnetOutput(),
    new MqttOutput(config, {
      setLayerAValue: (fixtureId, featureId, value) => sequencer.setLayerAValue(fixtureId, featureId, value),
      clearLayerAFeature: (fixtureId, featureId) => sequencer.clearLayerAFeature(fixtureId, featureId),
      clearLayerAFixture: (fixtureId) => sequencer.clearLayerAFixture(fixtureId),
      applyLayerABatch: (operations) => sequencer.applyLayerABatch(operations),
      setSpm: (spm) => sequencer.setSpm(spm),
      setBlackout: (enabled) => sequencer.setBlackout(enabled),
      pause: () => sequencer.pause(),
      playFromStart: () => {
        sequencer.setStep(0);
        sequencer.resume();
      },
      triggerProgram: (programId) => {
        const program = programStore.get(programId);
        if (!program) return;
        const currentState = sequencer.getState();
        if (!currentState.isPlaying) {
          sequencer.setSpm(program.spm);
        }
        applyProgram(programId);
        sequencer.setStep(0);
        sequencer.resume();
      },
      listPrograms: () => programStore.list(),
    }),
  ]);

  sequencer.subscribe((frame) => {
    wsHub.broadcast({ type: "frame", payload: frame });

    const programId = frame.state.programId;
    if (!programId) return;
    const program = programStore.get(programId);
    if (!program) return;

    const packet = buildRenderPacket(frame, config, program.environmentId);
    if (!packet) return;
    if (debug) {
      const universeSummary = Object.entries(packet.dmxByUniverse).map(([universe, dmx]) => {
        let nonZero = 0;
        let checksum = 0;
        const sample: Array<{ address: number; value: number }> = [];
        for (let i = 0; i < dmx.length; i += 1) if (dmx[i] > 0) nonZero += 1;
        for (let i = 0; i < dmx.length; i += 1) {
          const value = dmx[i];
          checksum = (checksum + (i + 1) * value) % 1000000007;
          if (value > 0 && sample.length < 12) {
            sample.push({ address: i + 1, value });
          }
        }
        return { universe: Number(universe), nonZero, checksum, sample };
      });
      app.log.info(
        {
          tag: "sync-debug",
          phase: "render-packet",
          programId,
          stepIndex: frame.state.stepIndex,
          universeSummary,
        },
        "Render packet built",
      );
    }
    renderer.render(packet);
  });

  await registerRoutes(app, { config, programStore, sequencer, wsHub });

  app.get("/ws", { websocket: true }, (connection) => {
    wsHub.addClient(connection, (event: ClientEvent) => {
      switch (event.type) {
        case "play":
          sequencer.play();
          break;
        case "pause":
          sequencer.pause();
          break;
        case "next":
          sequencer.nextStep();
          break;
        case "previous":
          sequencer.previousStep();
          break;
        case "seek":
          sequencer.setStep(event.payload.stepIndex);
          break;
        case "blackout":
          sequencer.setBlackout(event.payload.enabled);
          break;
        case "tempo":
          sequencer.setSpm(event.payload.spm);
          break;
        case "loop":
          sequencer.setLoop(event.payload.enabled);
          break;
        case "program": {
          applyProgram(event.payload.programId);
          break;
        }
        case "layerASet":
          sequencer.setLayerAValue(event.payload.fixtureId, event.payload.featureId, event.payload.value);
          break;
        case "layerAClearFeature":
          sequencer.clearLayerAFeature(event.payload.fixtureId, event.payload.featureId);
          break;
        case "layerAClearFixture":
          sequencer.clearLayerAFixture(event.payload.fixtureId);
          break;
      }
      if (debug) {
        app.log.info({ tag: "ws-debug", event }, "Handled WS client event");
      }
    });

    wsHub.broadcast({ type: "programs", payload: programStore.list() });
    wsHub.broadcast({
      type: "config",
      payload: { fixtures: config.fixtures, environments: config.environments },
    });

    const socket = connectionSocket(connection as ConnectionLike);
    const initialFrameEvent: ServerEvent = { type: "frame", payload: sequencer.getFrame() };
    socket.send(JSON.stringify(initialFrameEvent));
  });

  const defaultProgram = programStore.list()[0];
  if (defaultProgram) {
    applyProgram(defaultProgram.id);
  }
  applyDefaultStaticPanelValues(config, sequencer);

  app.get("/", async (_, reply) => {
    return reply.sendFile("index.html");
  });

  return app;
}

const port = Number(process.env.PORT ?? 3000);
const app = await buildServer();
await app.listen({ port, host: "0.0.0.0" });
