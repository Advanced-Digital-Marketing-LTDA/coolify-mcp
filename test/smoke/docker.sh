#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
image=coolify-mcp:smoke
container=
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT HUP INT TERM
docker build --tag "$image" .
# No live configuration, published ports or external network. Only test fixtures are mounted.
container=$(docker run -d --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 512m --cpus 1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --mount "type=bind,src=$(pwd)/test/smoke,dst=/app/test/smoke,readonly" \
  --health-interval 1s --health-start-period 1s --health-retries 3 \
  "$image" node --import ./test/smoke/fixture.mjs dist/src/host.js)
attempt=0
while [ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" != healthy ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ] || [ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]; then
    docker logs "$container"
    docker inspect --format '{{json .State.Health}}' "$container"
    echo "Synthetic container did not become healthy" >&2
    exit 1
  fi
  sleep 1
done
docker exec "$container" node test/smoke/check.mjs --container
docker stop --time 5 "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = 0
docker rm "$container" >/dev/null
container=
# The unmodified image must fail closed without owner activation settings.
container=$(docker create --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true "$image")
if docker start -a "$container"; then
  :
else
  test "$?" = 1
fi
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = 1
test "$(docker logs "$container" 2>&1)" = "Hosted MCP startup failed; verify activation settings and connectivity."
echo "Docker smoke passed: healthcheck, non-root/read-only runtime, production dependencies, fail-closed startup and SIGTERM shutdown."
