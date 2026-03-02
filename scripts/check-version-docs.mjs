#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import readline from "node:readline";

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function readText(path) {
  return fs.readFileSync(path, "utf-8");
}

async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();

    server.on("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate available port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function readServerReadyVersion() {
  const port = await getAvailablePort();

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/server.js"], {
      env: {
        ...process.env,
        PI_SERVER_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;

    const finish = (error, version) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        rl.close();
      } catch {
        // Ignore close errors
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore kill errors
      }
      if (error) {
        reject(error);
      } else {
        resolve(version);
      }
    };

    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for server_ready from dist/server.js"));
    }, 8000);

    const rl = readline.createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;

      try {
        const message = JSON.parse(trimmed);
        if (message?.type === "server_ready") {
          const version = message?.data?.serverVersion;
          if (typeof version === "string" && version.length > 0) {
            finish(undefined, version);
          }
        }
      } catch {
        // Ignore non-JSON/non-ready lines
      }
    });

    child.on("error", (error) => finish(error));

    child.on("exit", (code, signal) => {
      if (settled) return;
      finish(
        new Error(
          `Server exited before emitting server_ready (code=${code ?? "null"}, signal=${signal ?? "null"})`
        )
      );
    });
  });
}

async function main() {
  const pkg = JSON.parse(readText("package.json"));
  const packageVersion = pkg.version;

  assert(typeof packageVersion === "string" && packageVersion.length > 0, "package.json missing version");

  const readyVersion = await readServerReadyVersion();
  assert(
    readyVersion === packageVersion,
    `Version drift: server_ready.serverVersion='${readyVersion}' but package.json version='${packageVersion}'`
  );

  const readme = readText("README.md");
  const protocol = readText("PROTOCOL.md");
  const roadmap = readText("ROADMAP.md");
  const adr0009 = readText("docs/adr/0009-connection-authentication.md");

  assert(
    fs.existsSync("docs/adr/0014-pluggable-authentication.md"),
    "Missing docs/adr/0014-pluggable-authentication.md"
  );

  assert(
    !readme.includes("Connection authentication (planned)"),
    "README still describes authentication as planned"
  );
  assert(readme.includes("ADR-0014"), "README missing ADR-0014 reference");

  assert(
    !protocol.includes("authentication (planned)"),
    "PROTOCOL still describes authentication as planned"
  );
  assert(protocol.includes("ADR-0014"), "PROTOCOL missing ADR-0014 reference");

  assert(
    adr0009.toLowerCase().includes("superseded"),
    "ADR-0009 must be marked as superseded"
  );

  assert(
    roadmap.includes("**Current phase:** Level 4 (Durable command journal + replay)"),
    "ROADMAP program status is not aligned with Level 4 planning"
  );

  console.log("✓ Version/docs consistency check passed");
}

main().catch((error) => {
  console.error("Version/docs consistency check failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
