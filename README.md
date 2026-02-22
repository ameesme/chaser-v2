# chaser-v2

Real-time lighting sequencer with:
- browser-based piano-roll editor + room visualizer
- ArtNet output
- MQTT output
- JSON-backed programs, fixtures, and environments

## Run

```bash
pnpm install
pnpm run dev
```

Server starts on `http://localhost:3000`.

## Scripts

- `pnpm run dev`: run server with watch mode
- `pnpm run check`: type-check
- `pnpm run build`: build to `dist/`
- `pnpm run artnet:test -- <args>`: send targeted ArtNet test patterns
- `pnpm run artnet:probe -- <args>`: probe panel/channel mapping

## Data Model

- `data/fixtures.json`: fixture type definitions
- `data/environments.json`: fixture placements, outputs, render FPS
- `data/programs.json`: sequencer programs and steps

## API

- `GET /health`
- `GET /api/programs`
- `POST /api/programs`
- `PUT /api/programs/:id`
- `DELETE /api/programs/:id`

## WebSocket Protocol

Client -> server:
- `play`
- `pause`
- `next`
- `previous`
- `seek` with `{ stepIndex }`
- `blackout` with `{ enabled }`
- `tempo` with `{ spm }`
- `loop` with `{ enabled }`
- `program` with `{ programId }`

Server -> client:
- `programs` with full program list
- `config` with fixtures + environments
- `frame` with rendered values + playhead state

## Project Layout

- `src/index.ts`: app bootstrap and wiring
- `src/api/routes.ts`: program CRUD routes
- `src/core/*`: sequencer, render packet, renderer, program store
- `src/outputs/*`: simulator, ArtNet, MQTT outputs
- `src/tools/artnet-test.ts`: ArtNet debug/probe CLI
- `src/ws/*`: websocket hub and protocol
- `public/*`: web editor/simulator UI
