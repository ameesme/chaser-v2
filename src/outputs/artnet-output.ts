import dgram from "node:dgram";
import type { RenderPacket } from "../core/render-packet.js";
import type { OutputDefinition } from "../config/types.js";
import type { Output } from "./output.js";

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

export class ArtnetOutput implements Output {
  readonly id = "artnet";
  private socket = dgram.createSocket("udp4");

  push(packet: RenderPacket): void {
    const isArtnetOutput = (
      output: OutputDefinition,
    ): output is Extract<OutputDefinition, { type: "artnet" }> =>
      output.type === "artnet" && output.enabled;

    const targets = packet.environment.outputs.filter(
      isArtnetOutput,
    );
    if (targets.length === 0) return;

    for (const target of targets) {
      const allowedUniverses = Array.isArray(target.universes)
        ? new Set(target.universes.map((value) => Number(value)))
        : null;
      for (const [universeRaw, dmx] of Object.entries(packet.dmxByUniverse)) {
        const universe = Number(universeRaw);
        if (allowedUniverses && !allowedUniverses.has(universe)) continue;
        const artPacket = buildArtDmxPacket(universe, dmx);
        this.socket.send(artPacket, target.port, target.host);
      }
    }
  }
}
