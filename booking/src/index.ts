import { Hono } from "hono";
import { SERVICES } from "./services";

type Env = { DB: D1Database };

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("Hello from the averywhitted.com booking service."));

// Public list of services and prices, read from services.ts.
app.get("/api/services", (c) => c.json(SERVICES));

// Quick check that the service can reach its database.
app.get("/api/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true, database: "connected" });
  } catch {
    return c.json({ ok: false, database: "unreachable" }, 500);
  }
});

export default app;
