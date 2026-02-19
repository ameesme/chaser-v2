import type { RenderPacket } from "../core/render-packet.js";
import type { Output } from "./output.js";

export class SimulatorOutput implements Output {
  readonly id = "simulator";
  private listeners = new Set<(packet: RenderPacket) => void>();

  push(packet: RenderPacket): void {
    for (const listener of this.listeners) {
      listener(packet);
    }
  }

  subscribe(listener: (packet: RenderPacket) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
