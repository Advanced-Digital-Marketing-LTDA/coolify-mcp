// Direct loopback only: no public Host, Origin, forwarded headers or credentials.
try {
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    redirect: "error", signal: AbortSignal.timeout(3000),
  });
  const body = await response.json();
  if (response.status !== 200 || body.status !== "ok" || Object.keys(body).length !== 1) throw new Error();
} catch {
  process.exitCode = 1;
}
