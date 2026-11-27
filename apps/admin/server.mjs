import {isWorkspacePath} from "./src/page-url.js";
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname } from "node:path";
import { createLocalBackend, PanelError } from "./backend.mjs";
import { AdminService } from "./service.mjs";
import { assistantReply, DEFAULT_MODEL } from "./assistant.mjs";
import {
  TRANSITION_POLICY,
  buildFrontendReporting,
  snapshotToFrontendReportingInput,
} from "../../.build/admin/domain.mjs";

const base = fileURLToPath(new URL("./", import.meta.url));
export function createPanelServer(service, { assistantKey, port = 4173 } = {}) {
  const sessions = new Map();
  const equal = (a, b) =>
    typeof a === "string" &&
    typeof b === "string" &&
    a.length === b.length &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://drive.google.com https://drive.usercontent.google.com https://lh3.googleusercontent.com https://work.fife.usercontent.google.com; connect-src 'self'; frame-src 'self' https://drive.google.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const json = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      const expected = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== expected)
        throw new PanelError(
          "INVALID_HOST",
          "Open the panel using its local address.",
          403,
        );
      const url = new URL(req.url, `http://${expected}`);
      if (url.pathname.startsWith("/api/")) {
        if (req.headers.origin && req.headers.origin !== `http://${expected}`)
          throw new PanelError(
            "INVALID_ORIGIN",
            "This request came from another site.",
            403,
          );
        if (req.headers["sec-fetch-site"] === "cross-site")
          throw new PanelError(
            "INVALID_ORIGIN",
            "This request came from another site.",
            403,
          );
        let body = {};
        if (req.method === "POST") {
          if (
            req.headers.origin !== `http://${expected}` ||
            !req.headers["content-type"]?.startsWith("application/json")
          )
            throw new PanelError(
              "INVALID_ORIGIN",
              "Use the administrator panel to submit changes.",
              403,
            );
          let raw = "";
          for await (const chunk of req) {
            raw += chunk;
            if (Buffer.byteLength(raw) > 65536)
              throw new PanelError(
                "TOO_LARGE",
                "Please make a smaller request.",
                413,
              );
          }
          try {
            body = JSON.parse(raw);
          } catch {
            throw new PanelError(
              "INVALID_REQUEST",
              "The request could not be read.",
            );
          }
        }
        if (req.method === "POST" && url.pathname === "/api/session") {
          if (sessions.size > 100)
            for (const [id, s] of sessions)
              if (s.expires < Date.now()) sessions.delete(id);
          if (sessions.size >= 100)
            throw new PanelError(
              "SESSION_LIMIT",
              "Close old panel sessions and restart the local panel.",
              429,
            );
          const id = randomBytes(32).toString("hex"),
            csrf = randomBytes(32).toString("hex");
          sessions.set(id, { csrf, expires: Date.now() + 8 * 3600000 });
          res.setHeader(
            "Set-Cookie",
            `shamrock_local=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
          );
          return json(200, { csrf });
        }
        const id = req.headers.cookie
            ?.split(";")
            .map((v) => v.trim())
            .find((v) => v.startsWith("shamrock_local="))
            ?.slice(15),
          session = sessions.get(id);
        if (!session || session.expires < Date.now())
          throw new PanelError(
            "SESSION_EXPIRED",
            "Reload the panel to start a new local session.",
            401,
          );
        if (
          req.method === "POST" &&
          !equal(session.csrf, req.headers["x-shamrock-csrf"])
        )
          throw new PanelError(
            "INVALID_SESSION",
            "Reload before saving a change.",
            403,
          );
        if (req.method === "GET" && url.pathname === "/api/state") {
          const snapshot = await service.snapshot();
          const current = snapshot.terms.find((t) => t.isCurrent);
          const reporting = current
            ? buildFrontendReporting(
                snapshotToFrontendReportingInput(
                  snapshot,
                  new Intl.DateTimeFormat("en-CA", {
                    timeZone: "America/Indiana/Indianapolis",
                  }).format(new Date()),
                ),
              )
            : null;
          return json(200, {
            snapshot,
            reporting,
            history: await service.history(),
            meta: {
              environment: service.backend.environment,
              fictional: service.backend.environment === "local",
              assistantAvailable: !!assistantKey,
              model: DEFAULT_MODEL,
              transitionPolicy: TRANSITION_POLICY,
            },
          });
        }
        if (req.method === "POST" && url.pathname === "/api/proposals")
          return json(200, await service.propose(body.operation, body.payload));
        const action = url.pathname.match(
          /^\/api\/proposals\/([a-f0-9-]{36})\/(apply|cancel)$/,
        );
        if (req.method === "POST" && action)
          return json(
            200,
            action[2] === "apply"
              ? await service.apply(action[1], body.approved)
              : await service.cancel(action[1]),
          );
        if (req.method === "GET" && url.pathname === "/api/transition")
          return json(
            200,
            await service.transition(url.searchParams.get("id")),
          );
        if (req.method === "POST" && url.pathname === "/api/chat") {
          if (session.chatBusy)
            throw new PanelError(
              "ASSISTANT_BUSY",
              "Wait for your current answer.",
              429,
            );
          if (session.lastChat && Date.now() - session.lastChat < 5000)
            throw new PanelError(
              "ASSISTANT_LIMIT",
              "Wait a moment before asking again.",
              429,
            );
          session.chatBusy = true;
          session.lastChat = Date.now();
          try {
            return json(
              200,
              await assistantReply({
                key: assistantKey,
                messages: body.messages,
                service,
              }),
            );
          } finally {
            session.chatBusy = false;
          }
        }
        throw new PanelError("NOT_FOUND", "This action is unavailable.", 404);
      }
      if (req.method !== "GET")
        throw new PanelError("NOT_FOUND", "Not found.", 404);
      const path =
        (url.pathname === "/" || isWorkspacePath(url.pathname))
          ? "index.html"
          : decodeURIComponent(url.pathname.slice(1));
      const file = resolve(base, "dist", path);
      if (!file.startsWith(resolve(base, "dist") + "/"))
        throw new PanelError("NOT_FOUND", "Not found.", 404);
      const content = await readFile(file);
      res.writeHead(200, {
        "content-type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
          }[extname(file)] || "application/octet-stream",
      });
      res.end(content);
    } catch (e) {
      json(e.status || (e.code === "ENOENT" ? 404 : 400), {
        error: {
          code: e.code || "REQUEST_FAILED",
          message:
            e instanceof PanelError
              ? e.message
              : e.name === "DomainError"
                ? e.message
                : "The operation could not be completed. Reload and try the saved change again.",
        },
      });
    }
  });
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // This development host is deliberately loopback-only. Hosted identity is a separate release gate.
  const { schema } = JSON.parse(
    await readFile(resolve(base, "../../.build/admin/schema.json"), "utf8"),
  );
  if (!/^[a-f0-9]{64}$/.test(schema))
    throw new Error("Rebuild the isolated panel artifacts.");
  const data = resolve(base, "../../.build/admin/data", schema.slice(0, 16));
  await mkdir(data, { recursive: true });
  const local = await createLocalBackend(resolve(data, "d1"));
  const service = new AdminService(
    local.backend,
    resolve(data, "panel.sqlite"),
  );
  const server = createPanelServer(service, {
    assistantKey: process.env.SHAMROCK_CRC_API_KEY,
  });
  server.listen(4173, "127.0.0.1", () =>
    console.log(
      "SHAMROCK local staging: http://127.0.0.1:4173 — fictional records only.",
    ),
  );
  const close = () =>
    server.close(async () => {
      service.close();
      await local.dispose();
      process.exit(0);
    });
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
