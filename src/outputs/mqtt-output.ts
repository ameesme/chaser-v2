import mqtt from "mqtt";
import type { MqttClient } from "mqtt";
import type { RenderPacket } from "../core/render-packet.js";
import type { OutputDefinition } from "../config/types.js";
import type { Output } from "./output.js";

export class MqttOutput implements Output {
  readonly id = "mqtt";
  private clients = new Map<string, MqttClient>();

  push(packet: RenderPacket): void {
    const isMqttOutput = (
      output: OutputDefinition,
    ): output is Extract<OutputDefinition, { type: "mqtt" }> =>
      output.type === "mqtt" && output.enabled;

    const targets = packet.environment.outputs.filter(
      isMqttOutput,
    );
    if (targets.length === 0) return;

    for (const target of targets) {
      const client = this.getClient(target.brokerUrl);
      if (!client.connected) continue;

      client.publish(
        target.topic,
        JSON.stringify({
          timestamp: packet.frame.timestamp,
          state: packet.frame.state,
          values: packet.frame.values,
          dmxByUniverse: Object.fromEntries(
            Object.entries(packet.dmxByUniverse).map(([universe, data]) => [
              universe,
              Array.from(data),
            ]),
          ),
        }),
      );
    }
  }

  private getClient(brokerUrl: string): MqttClient {
    const existing = this.clients.get(brokerUrl);
    if (existing) return existing;

    const client = mqtt.connect(brokerUrl);
    client.on("error", () => {
      // Keep renderer hot even when broker is down.
    });
    this.clients.set(brokerUrl, client);
    return client;
  }
}
