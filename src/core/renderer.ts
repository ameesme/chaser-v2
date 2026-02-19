import type { RenderPacket } from "./render-packet.js";
import type { Output } from "../outputs/output.js";

export class Renderer {
  constructor(private readonly outputs: Output[]) {}

  render(packet: RenderPacket): void {
    for (const output of this.outputs) {
      output.push(packet);
    }
  }
}
