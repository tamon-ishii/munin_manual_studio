import { defineConfig } from "vite";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));
const configuredTarget = process.env.CARGO_TARGET_DIR;
const target = configuredTarget
  ? path.isAbsolute(configuredTarget) ? configuredTarget : path.resolve(root, "../../", configuredTarget)
  : path.resolve(root, "../../target");
const cli = path.join(target, "debug", process.platform === "win32" ? "manualctl.exe" : "manualctl");

export default defineConfig({
  root, base: "./", clearScreen: false,
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
  build: { outDir: "dist", target: "es2022", emptyOutDir: true },
  plugins: [{
    name: "manual-studio-local-development",
    configureServer(server) {
      server.middlewares.use("/__manual/rpc", (request, response) => {
        if (request.method !== "POST" || !request.headers["content-type"]?.startsWith("application/json")) {
          response.statusCode = 405; response.end(); return;
        }
        // This bridge exists only on the loopback development server.
        const origin = request.headers.origin;
        if (origin && origin !== "http://127.0.0.1:5174" && origin !== "http://localhost:5174") {
          response.statusCode = 403; response.end(); return;
        }
        let body = "";
        request.on("data", (chunk) => { body += chunk; if (body.length > 5_000_000) request.destroy(); });
        request.on("end", () => {
          try { JSON.parse(body); } catch { response.statusCode = 400; response.end(); return; }
          execFile(cli, ["--request", body], { maxBuffer: 15_000_000, timeout: 360_000 }, (error, stdout, stderr) => {
            response.setHeader("Content-Type", "application/json");
            response.statusCode = error ? 400 : 200;
            response.end(JSON.stringify(error ? { error: stderr.trim() || error.message } : { output: stdout.trimEnd() }));
          });
        });
      });
    },
  }],
});
