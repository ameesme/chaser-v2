# chaser-v2

A real-time DMX sequencer with a WebSocket-first architecture and a retro black/white browser simulator.

## Current Status

Initial vertical slice is implemented:
- Node.js + Fastify server
- JSON-based fixture/environment/program definitions
- Program CRUD API
- Sequencer transport (`play`, `pause`, `next`, `previous`, `tempo`, `blackout`)
- Step interpolation (fade between steps)
- WebSocket real-time frame/state/program events
- Retro Web UI with transport controls, program switcher, step-grid stub, and simulator panel
- Renderer abstraction with simulator output + ArtNet/MQTT stubs

## Run

```bash
npm install
npm run dev
```

Server starts on `http://localhost:3000`.

## Project Structure

- `src/index.ts`: app bootstrap, websocket route, and wiring
- `src/config/*`: domain types + runtime JSON loading
- `src/core/program-store.ts`: program CRUD persistence to `data/programs.json`
- `src/core/sequencer.ts`: transport and frame generation
- `src/core/renderer.ts`: fan-out to outputs
- `src/outputs/*`: simulator output and placeholder external outputs
- `src/api/routes.ts`: REST API
- `src/ws/*`: websocket protocol and hub
- `data/*.json`: fixture/environment/program definitions
- `public/*`: minimalist retro simulator UI

## API

- `GET /health`
- `GET /api/programs`
- `POST /api/programs`
- `PUT /api/programs/:id`
- `DELETE /api/programs/:id`
- `GET /api/state`
- `POST /api/control`

Control body examples:

```json
{ "action": "play" }
```

```json
{ "action": "tempo", "bpm": 132 }
```

```json
{ "action": "program", "programId": "prog-bounce" }
```

## WebSocket Contract

Client -> server:
- `play`
- `pause`
- `next`
- `previous`
- `tempo` with `{ bpm }`
- `blackout` with `{ enabled }`
- `program` with `{ programId }`

Server -> client:
- `programs` with full list of programs
- `state` with transport state
- `frame` with rendered feature values + state snapshot

## Plan

### Phase 1 (Done)
- Establish domain model and JSON config format
- Build websocket + REST transport control
- Create initial browser simulator

### Phase 2 (In Progress)
- Add fixture feature grouping controls (single color control over multiple channels)
- Extend piano-roll editor from stub to editable keyframes
- Add proper fixture layout from environment dimensions in simulator
- Implement robust validation for program/environment compatibility

### Phase 3
- Implement real ArtNet output
- Implement MQTT output publishing schema
- Add output health/latency telemetry in UI
- Add save/load versioning and migration strategy for JSON

### Phase 4
- Add testing: sequencer timing, interpolation, API contract, websocket contract
- Add session recording/replay for deterministic debugging
- Add production packaging and deployment profile

## Immediate Next Tasks

1. Complete editable keyframe timeline in `public/app.js` + API endpoints.
2. Replace placeholder output stubs with real ArtNet and MQTT adapters.
3. Add input/data validation and automated tests for `src/core/sequencer.ts`.
