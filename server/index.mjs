import { createApi } from "./http.mjs";
import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeCheckpointDirectory = process.env.FIELDLINE_RUNTIME_CHECKPOINT_DIR ||
  path.join(root, ".fieldline", "runtime");
const allowedOrigins = String(process.env.FIELDLINE_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
const { app, close, checkpointRuntime } = createApi({
  saveDirectory: path.join(root, ".fieldline", "saves"),
  runtimeCheckpointDirectory,
  resumeRuntime: process.env.FIELDLINE_RESUME_RUNTIME !== "0",
  allowedOrigins,
});
app.use((req, res, next) => {
  if (decodeURIComponent(req.path).includes(".fieldline"))
    return res.sendStatus(404);
  next();
});
let vite;
app.get("/preview.png", (_req, res) =>
  res.status(410).send("폐기된 시안입니다."),
);
app.get("/preview", (_req, res) => res.redirect("/"));
if (process.argv.includes("--dev")) {
  const { createServer } = await import("vite");
  vite = await createServer({
    root,
    server: {
      middlewareMode: true,
      ws: { host: "127.0.0.1", port: 4319 },
      fs: {
        deny: [
          ".env",
          ".env.*",
          "*.{crt,pem}",
          "**/.git/**",
          "**/.fieldline/**",
        ],
      },
    },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(root, "dist/index.html")),
  );
}
const port = Number(process.env.FIELDLINE_PORT ?? 4318);
const server = app.listen(port, "127.0.0.1", () =>
  console.log(`들녘 / FIELDLINE — http://localhost:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (runtimeCheckpointDirectory)
      try {
        await checkpointRuntime?.();
      } catch (error) {
        console.error(`런타임 체크포인트를 기록하지 못했어요: ${error.message}`);
      }
    close();
    await vite?.close();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
