# pi-server Quickstart

A minimal operator guide to get `pi-server` running and verified in minutes.

---

## 1) Install and build

```bash
npm install
npm run build
```

---

## 2) Start the server

```bash
node dist/server.js
```

By default:

- WebSocket: `ws://localhost:3141`
- stdio: newline-delimited JSON on stdin/stdout

Use a custom port:

```bash
PI_SERVER_PORT=4242 node dist/server.js
```

---

## 3) Smoke test via stdio

```bash
echo '{"id":"1","type":"list_sessions"}' | node dist/server.js
```

Expected: a `response` object with `success: true` and `command: "list_sessions"`.

---

## 4) Minimal session flow

```bash
echo '{"id":"1","type":"create_session","sessionId":"demo"}
{"id":"2","type":"switch_session","sessionId":"demo"}
{"id":"3","type":"prompt","sessionId":"demo","message":"hello"}' | node dist/server.js
```

---

## 5) Run tests

```bash
npm test
npm run test:integration
npm run check
```

---

## 6) What to read next

- `README.md` — architecture-oriented overview
- `docs/client-guide.md` — client integration best practices
- `PROTOCOL.md` — normative wire contract (MUST/SHOULD semantics)
- `ROADMAP.md` — phase and decision tracking
