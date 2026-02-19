import type { RenderPacket } from "../core/render-packet.js";

export interface Output {
  readonly id: string;
  push(packet: RenderPacket): void;
}
