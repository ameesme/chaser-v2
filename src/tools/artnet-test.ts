import dgram from "node:dgram";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { EnvironmentDefinition, OutputDefinition } from "../config/types.js";

type Fixture = EnvironmentDefinition["fixtures"][number];

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      out[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function asNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === "false") return false;
  if (value === "0") return false;
  return true;
}

function parseAddressList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item >= 1 && item <= 512)
    .map((item) => Math.floor(item));
}

function buildArtDmxPacket(universe: number, dmx: Uint8Array): Buffer {
  const header = Buffer.alloc(18);
  header.write("Art-Net\0", 0, "ascii");
  header.writeUInt16LE(0x5000, 8);
  header.writeUInt16BE(14, 10);
  header.writeUInt8(0, 12);
  header.writeUInt8(0, 13);
  header.writeUInt16LE(universe & 0x7fff, 14);
  header.writeUInt16BE(dmx.length, 16);
  return Buffer.concat([header, Buffer.from(dmx)]);
}

function summarizeFrame(frame: Uint8Array): {
  nonZero: number;
  checksum: number;
  sample: Array<{ address: number; value: number }>;
} {
  let nonZero = 0;
  let checksum = 0;
  const sample: Array<{ address: number; value: number }> = [];
  for (let i = 0; i < frame.length; i += 1) {
    const value = frame[i];
    if (value > 0) {
      nonZero += 1;
      if (sample.length < 16) sample.push({ address: i + 1, value });
    }
    checksum = (checksum + (i + 1) * value) % 1000000007;
  }
  return { nonZero, checksum, sample };
}

function isArtnetOutput(
  output: OutputDefinition,
): output is Extract<OutputDefinition, { type: "artnet" }> {
  return output.type === "artnet";
}

function panelNumber(name: string): number | null {
  const match = /^Panel\s+(\d+)$/i.exec(name.trim());
  if (!match) return null;
  return Number(match[1]);
}

function setFixtureChannel(frame: Uint8Array, fixture: Fixture, channel: number, value: number): void {
  const dmxAddress = fixture.address + channel - 1;
  if (dmxAddress < 1 || dmxAddress > 512) return;
  frame[dmxAddress - 1] = Math.max(0, Math.min(255, Math.round(value)));
}

async function loadEnvironment(environmentId: string): Promise<EnvironmentDefinition> {
  const file = resolve(process.cwd(), "data/environments.json");
  const raw = await readFile(file, "utf8");
  const environments = JSON.parse(raw) as EnvironmentDefinition[];
  const environment = environments.find((item) => item.id === environmentId);
  if (!environment) {
    throw new Error(`Environment not found: ${environmentId}`);
  }
  return environment;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const debug = process.env.CHASER_DEBUG === "1" || asBool(args.debug);
  const environmentId = args.env ?? "env-studio-a";
  const environment = await loadEnvironment(environmentId);
  const artnet = environment.outputs.find(isArtnetOutput);

  const host = args.host ?? artnet?.host ?? "192.168.50.122";
  const port = asNumber(args.port, artnet?.port ?? 6454);
  const universe = asNumber(args.universe, 0);
  const stepDelayMs = asNumber(args.delay, 250);
  const probeMode = asBool(args.probe);
  const persistMode = asBool(args.persist);
  const phaseArg = (args.phase ?? "both").toLowerCase();
  const runLogicalPhase = phaseArg === "both" || phaseArg === "logical";
  const runRawPhase = phaseArg === "both" || phaseArg === "raw";
  const probePanelNumber = asNumber(args.panel, 1);
  const probeRawSlots = Math.max(8, asNumber(args.slots, 16));
  const probeValue = Math.max(0, Math.min(255, asNumber(args.value, 21)));
  const persistHoldMs = Math.max(200, asNumber(args.hold, 3000));
  const persistRefreshMs = Math.max(20, asNumber(args.refresh, 40));
  const persistCycles = Math.max(1, asNumber(args.cycles, 2));
  const persistAddresses = parseAddressList(args.addresses);

  const panels = environment.fixtures
    .filter((fixture) => fixture.fixtureTypeId === "fixture-rgbcct-5ch")
    .map((fixture) => ({ fixture, number: panelNumber(fixture.name) }))
    .filter((item): item is { fixture: Fixture; number: number } => item.number !== null)
    .sort((a, b) => a.number - b.number)
    .map((item) => item.fixture);

  if (panels.length !== 14) {
    throw new Error(`Expected 14 panel fixtures, found ${panels.length}`);
  }

  const channels = [
    { label: "R", channel: 1 },
    { label: "G", channel: 2 },
    { label: "B", channel: 3 },
    { label: "WW", channel: 4 },
    { label: "CW", channel: 5 },
  ];

  const socket = dgram.createSocket("udp4");
  const sendFrame = async (frame: Uint8Array): Promise<void> => {
    const packet = buildArtDmxPacket(universe, frame);
    if (debug) {
      const summary = summarizeFrame(frame);
      console.info("[artnet-probe-debug] send", {
        host,
        port,
        universe,
        nonZero: summary.nonZero,
        checksum: summary.checksum,
        sample: summary.sample,
      });
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      socket.send(packet, port, host, (error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
  };

  console.log(`ArtNet target ${host}:${port}, universe ${universe}`);
  console.log(`Panels: ${panels.map((fixture) => fixture.name).join(", ")}`);

  if (persistMode) {
    const addresses = persistAddresses.length > 0
      ? persistAddresses
      : [1, 6, 11, 16];
    const onFrame = new Uint8Array(512);
    for (const address of addresses) onFrame[address - 1] = probeValue;
    const offFrame = new Uint8Array(512);

    console.log("\nPersist mode");
    console.log(`  addresses: ${addresses.join(", ")}`);
    console.log(`  value: ${probeValue}`);
    console.log(`  hold: ${persistHoldMs}ms`);
    console.log(`  refresh: ${persistRefreshMs}ms`);
    console.log(`  cycles: ${persistCycles}`);

    const repeatSend = async (frame: Uint8Array, durationMs: number, label: string): Promise<void> => {
      const endAt = Date.now() + durationMs;
      let sends = 0;
      while (Date.now() < endAt) {
        await sendFrame(frame);
        sends += 1;
        await delay(persistRefreshMs);
      }
      console.log(`  ${label}: sent ${sends} frames`);
    };

    for (let cycle = 1; cycle <= persistCycles; cycle += 1) {
      console.log(`\nCycle ${cycle}/${persistCycles}`);
      await repeatSend(onFrame, persistHoldMs, "ON hold");
      await repeatSend(offFrame, persistHoldMs, "OFF hold");
    }

    await sendFrame(offFrame);
    socket.close();
    console.log("\nPersist done. Sent final blackout frame.");
    return;
  }

  if (probeMode) {
    const panel = panels.find((fixture) => panelNumber(fixture.name) === probePanelNumber);
    if (!panel) {
      throw new Error(`Panel ${probePanelNumber} not found`);
    }

    console.log(`\nProbe mode: ${panel.name} at universe ${panel.universe}, address ${panel.address}`);
    if (panel.universe !== universe) {
      console.log(
        `Warning: selected panel is on universe ${panel.universe}, but sending on ${universe}.`,
      );
    }

    if (runLogicalPhase) {
      console.log("\nPhase 1: logical feature channels (1..5)");
      const logical = [
        { label: "R", channel: 1 },
        { label: "G", channel: 2 },
        { label: "B", channel: 3 },
        { label: "WW", channel: 4 },
        { label: "CW", channel: 5 },
      ];
      for (const ch of logical) {
        const frame = new Uint8Array(512);
        setFixtureChannel(frame, panel, ch.channel, probeValue);
        await sendFrame(frame);
        console.log(`  ${panel.name} ${ch.label} -> ${probeValue}`);
        await delay(stepDelayMs);
        await sendFrame(new Uint8Array(512));
        await delay(Math.max(100, Math.floor(stepDelayMs * 0.5)));
      }
    }

    if (runRawPhase) {
      console.log(`\nPhase 2: raw DMX slots at base address..+${probeRawSlots - 1}`);
      for (let offset = 0; offset < probeRawSlots; offset += 1) {
        const frame = new Uint8Array(512);
        const dmxAddress = panel.address + offset;
        if (dmxAddress >= 1 && dmxAddress <= 512) {
          frame[dmxAddress - 1] = probeValue;
        }
        await sendFrame(frame);
        console.log(`  slot ${dmxAddress} (offset ${offset}) -> ${probeValue}`);
        await delay(stepDelayMs);
        await sendFrame(new Uint8Array(512));
        await delay(Math.max(100, Math.floor(stepDelayMs * 0.5)));
      }
    }

    if (!runLogicalPhase && !runRawPhase) {
      throw new Error(`Invalid --phase value: ${phaseArg}. Use logical, raw, or both.`);
    }

    await sendFrame(new Uint8Array(512));
    socket.close();
    console.log("\nProbe done. Sent blackout frame at end.");
    return;
  }

  for (const channel of channels) {
    console.log(`\nChannel ${channel.label}: panel chase`);
    for (let i = 0; i < panels.length; i += 1) {
      const frame = new Uint8Array(512);
      setFixtureChannel(frame, panels[i], channel.channel, 21);
      await sendFrame(frame);
      console.log(`  ${panels[i].name} -> ${channel.label}=21`);
      await delay(stepDelayMs);
    }

    console.log(`Channel ${channel.label}: value sweep (0..21 across all panels)`);
    for (let value = 0; value <= 21; value += 1) {
      const frame = new Uint8Array(512);
      for (let i = 0; i < panels.length; i += 1) {
        const panelValue = (value + i) % 22;
        setFixtureChannel(frame, panels[i], channel.channel, panelValue);
      }
      await sendFrame(frame);
      console.log(`  ${channel.label} base=${value} (panels offset modulo 22)`);
      await delay(stepDelayMs);
    }
  }

  await sendFrame(new Uint8Array(512));
  socket.close();
  console.log("\nDone. Sent blackout frame at end.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
