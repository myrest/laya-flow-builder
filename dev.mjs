import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const apiPort = process.env.API_PORT ?? process.env.PORT ?? "3000";
const webPort = process.env.WEB_PORT ?? "5173";
const commands = [
  {
    name: "api",
    args: [path.join(root, "node_modules/.bin/tsx"), "server.ts"],
    env: { ...process.env, PORT: apiPort },
  },
  {
    name: "web",
    args: [path.join(root, "web/node_modules/.bin/vite"), "--config", path.join(root, "web/vite.config.ts"), "--host", "0.0.0.0", "--port", webPort, "--strictPort"],
    env: { ...process.env, API_PORT: apiPort },
  },
];
const children = [];
let stopping = false;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill(signal);
}

for (const command of commands) {
  const child = spawn(process.execPath, command.args, {
    cwd: root,
    env: command.env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of chunk.split(/(?<=\n)/)) if (line) process.stdout.write(`[${command.name}] ${line}`);
    });
  }
  child.once("error", (error) => {
    console.error(`[${command.name}]`, error.message);
    stop();
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`[${command.name}] exited (${signal ?? code}); stopping the other service.`);
      stop();
    }
  });
}

console.log(`API: http://0.0.0.0:${apiPort} · editor: http://0.0.0.0:${webPort}`);
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

await Promise.all(children.map((child) => new Promise((resolve) => child.once("exit", resolve))));
