// Free the relay's port by killing whatever is listening on it.
//
// Exists because a relay is easy to leave behind: a forgotten terminal, a crashed dev
// session, an agent's background task — and the next `pnpm relay` then dies with
// EADDRINUSE. This finds every process LISTENING on the relay port and kills it, by port
// rather than by process name, so it never touches an unrelated node process.
//
// Same PORT contract as relay.mjs: env PORT, default 8787. Run: pnpm relay-kill
import { execSync } from "node:child_process";

const PORT = Number(process.env.PORT) || 8787;

/** PIDs listening on the port, per platform. Silent empty on lookup failure — "nothing
 *  to kill" and "netstat unavailable" both mean there is no work this script can do. */
function listeningPids() {
  const pids = new Set();
  try {
    if (process.platform === "win32") {
      const out = execSync("netstat -ano -p TCP", { encoding: "utf8" });
      for (const line of out.split("\n")) {
        // "  TCP    0.0.0.0:8787    0.0.0.0:0    LISTENING    12345"
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
        if (m && Number(m[1]) === PORT) pids.add(Number(m[2]));
      }
    } else {
      const out = execSync(`lsof -ti tcp:${PORT} -s tcp:LISTEN`, { encoding: "utf8" });
      for (const line of out.split("\n")) if (line.trim()) pids.add(Number(line.trim()));
    }
  } catch {
    /* no listeners (lsof exits 1 on none) or no netstat — nothing to do either way */
  }
  return [...pids];
}

const pids = listeningPids();
if (pids.length === 0) {
  console.log(`[relay-kill] nothing is listening on port ${PORT}.`);
  process.exit(0);
}
for (const pid of pids) {
  try {
    if (process.platform === "win32") execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
    console.log(`[relay-kill] killed PID ${pid} (was listening on :${PORT}).`);
  } catch (err) {
    console.error(`[relay-kill] could not kill PID ${pid}: ${String(err)}`);
    process.exitCode = 1;
  }
}
