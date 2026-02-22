import type { ClientEvent, ServerEvent } from "./protocol.js";

type EventHandler = (event: ClientEvent) => void;
type WebSocketLike = {
  OPEN: number;
  readyState: number;
  send: (payload: string) => void;
  on: (event: "message" | "close", listener: (data: unknown) => void) => void;
};
type Connection = { socket: WebSocketLike } | WebSocketLike;

export class WsHub {
  private sockets = new Set<WebSocketLike>();
  private debug = process.env.CHASER_DEBUG === "1";

  addClient(connection: Connection, onEvent: EventHandler): void {
    const socket = "socket" in connection ? connection.socket : connection;
    this.sockets.add(socket);
    if (this.debug) {
      console.info("[ws-debug] client added", { clients: this.sockets.size });
    }

    socket.on("message", (raw: unknown) => {
      try {
        const parsed = JSON.parse(String(raw)) as ClientEvent;
        if (this.debug) {
          console.info("[ws-debug] client event", parsed);
        }
        onEvent(parsed);
      } catch {
        if (this.debug) {
          console.info("[ws-debug] malformed client event", { raw: String(raw) });
        }
        // Ignore malformed client event.
      }
    });

    socket.on("close", () => {
      this.sockets.delete(socket);
      if (this.debug) {
        console.info("[ws-debug] client closed", { clients: this.sockets.size });
      }
    });
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    if (this.debug) {
      console.info("[ws-debug] broadcast", { type: event.type, clients: this.sockets.size });
    }
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }
}
