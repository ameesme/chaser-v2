import type { RenderPacket } from "../core/render-packet.js";
import type { Output } from "./output.js";

export class NoopOutput implements Output {
  constructor(readonly id: string) {}

  push(_packet: RenderPacket): void {
    // Placeholder output.
  }
}
