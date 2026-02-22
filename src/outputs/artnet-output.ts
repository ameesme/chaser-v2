import dgram from "node:dgram";
import type { RenderPacket } from "../core/render-packet.js";
import type { OutputDefinition } from "../config/types.js";
import type { Output } from "./output.js";

function buildArtDmxPacket(universe: number, dmx: Uint8Array): Buffer {
  const header = Buffer.alloc(18);
  header.write("Art-Net\0", 0, "ascii");
  header.writeUInt16LE(0x5000, 8);
  header.writeUInt16BE(14, 10);
  // Sequence 0 disables sequence handling on receivers (matches probe behavior).
  header.writeUInt8(0, 12);
  header.writeUInt8(0, 13);
  header.writeUInt16LE(universe & 0x7fff, 14);
  header.writeUInt16BE(dmx.length, 16);
  return Buffer.concat([header, Buffer.from(dmx)]);
}

type CachedFrame = {
  host: string;
  port: number;
  universe: number;
  dmx: Uint8Array;
};

export class ArtnetOutput implements Output {
  readonly id = "artnet";
  private socket = dgram.createSocket("udp4");
  private debug = process.env.CHASER_DEBUG === "1";
  private refreshMs = Math.max(20, Number(process.env.CHASER_ARTNET_REFRESH_MS ?? 40));
  private cachedFrames = new Map<string, CachedFrame>();
  private isFlushing = false;
  private flushRequested = false;

  constructor() {
    this.socket.on("error", (error) => {
      console.error("[artnet] socket error", error);
    });

    // Continuously send the latest frame for each target universe.
    setInterval(() => {
      this.requestFlush("tick");
    }, this.refreshMs);
  }

  push(packet: RenderPacket): void {
    const isArtnetOutput = (
      output: OutputDefinition,
    ): output is Extract<OutputDefinition, { type: "artnet" }> =>
      output.type === "artnet" && output.enabled;

    const targets = packet.environment.outputs.filter(isArtnetOutput);
    if (targets.length === 0) return;

    for (const target of targets) {
      const allowedUniverses = Array.isArray(target.universes)
        ? new Set(target.universes.map((value) => Number(value)))
        : null;

      for (const [universeRaw, dmx] of Object.entries(packet.dmxByUniverse)) {
        const universe = Number(universeRaw);
        if (allowedUniverses && !allowedUniverses.has(universe)) continue;

        const key = `${target.host}|${target.port}|${universe}`;
        this.cachedFrames.set(key, {
          host: target.host,
          port: target.port,
          universe,
          dmx: Uint8Array.from(dmx),
        });
      }
    }

    this.requestFlush("push");
  }

  private requestFlush(reason: "push" | "tick"): void {
    this.flushRequested = true;
    if (this.isFlushing) return;
    void this.flushLoop(reason);
  }

  private async flushLoop(initialReason: "push" | "tick"): Promise<void> {
    this.isFlushing = true;
    let reason: "push" | "tick" = initialReason;
    try {
      while (this.flushRequested) {
        this.flushRequested = false;
        const frames = [...this.cachedFrames.entries()];
        for (const [key, frame] of frames) {
          await this.sendFrame(key, frame, reason);
        }
        reason = "tick";
      }
    } finally {
      this.isFlushing = false;
    }
  }

  private async sendFrame(
    key: string,
    frame: CachedFrame,
    reason: "push" | "tick",
  ): Promise<void> {
    const packet = buildArtDmxPacket(frame.universe, frame.dmx);

    await new Promise<void>((resolvePromise) => {
      this.socket.send(packet, frame.port, frame.host, (error) => {
        if (error) {
          console.error("[artnet] send error", {
            key,
            host: frame.host,
            port: frame.port,
            universe: frame.universe,
            error: error.message,
          });
        }
        resolvePromise();
      });
    });

    if (!this.debug) return;

    let nonZero = 0;
    let checksum = 0;
    const sample: Array<{ address: number; value: number }> = [];
    for (let i = 0; i < frame.dmx.length; i += 1) {
      const value = frame.dmx[i];
      if (value > 0) {
        nonZero += 1;
        if (sample.length < 16) sample.push({ address: i + 1, value });
      }
      checksum = (checksum + (i + 1) * value) % 1000000007;
    }
    console.info("[artnet-debug] send", {
      reason,
      key,
      host: frame.host,
      port: frame.port,
      universe: frame.universe,
      nonZero,
      checksum,
      sample,
    });
  }
}
