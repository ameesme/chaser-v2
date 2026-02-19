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

  addClient(connection: Connection, onEvent: EventHandler): void {
    const socket = "socket" in connection ? connection.socket : connection;
    this.sockets.add(socket);

    socket.on("message", (raw: unknown) => {
      try {
        const parsed = JSON.parse(String(raw)) as ClientEvent;
        onEvent(parsed);
      } catch {
        // Ignore malformed client event.
      }
    });

    socket.on("close", () => {
      this.sockets.delete(socket);
    });
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }
}
