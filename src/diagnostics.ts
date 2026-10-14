export type DiagnosticEvent = Readonly<{
  id: string;
  at: string;
  operation: "auth" | "inventory" | "resource_read" | "diagnostic_read" | "deployment_history" | "env_key_names" | "deploy" | "restart" | "config_update";
  outcome: "ok" | "denied" | "failed";
  durationMs: number;
}>;

/** Fixed-shape in-memory ring buffer. It never accepts request payloads or error text. */
export class DiagnosticLog {
  private readonly rows: DiagnosticEvent[] = [];
  constructor(private readonly capacity = 100) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) throw new Error("Invalid diagnostic capacity");
  }
  record(operation: DiagnosticEvent["operation"], outcome: DiagnosticEvent["outcome"], durationMs: number): void {
    this.rows.push(Object.freeze({ id: crypto.randomUUID(), at: new Date().toISOString(), operation, outcome, durationMs: Math.max(0, Math.min(300_000, Math.round(durationMs))) }));
    if (this.rows.length > this.capacity) this.rows.splice(0, this.rows.length - this.capacity);
  }
  read(limit = 50): readonly DiagnosticEvent[] {
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(50, limit)) : 50;
    return this.rows.slice(-bounded).reverse();
  }
}
