// The OpenWar3 server on Railway — every setting its one service runs with, as code.
//
// Railway Infrastructure as Code (docs.railway.com/infrastructure-as-code). This file is the whole
// Railway project: one service, the relay in `server/` (docs/multiplayer.md "The OpenWar3 server
// (Railway)"). It is NOT applied on push. Apply it from a checkout that is logged in and linked to
// the project, with the Railway CLI 5.42.1 or newer:
//
//   railway config plan     # what would change — read it
//   railway config apply    # applies after you confirm
//
// Omit means DELETE: a service, variable or volume the Railway project has and this file does not
// is planned for deletion. Everything the project holds belongs in here.
//
// Written against the `railway` dev dependency's own types (railway/iac `BuildConfig` and
// `DeployConfig`) rather than the reference page, which lists neither the watch patterns nor the
// restart and sleep fields — the SDK hands a `build` object and `deploy` fields to the graph as
// they are.

import { defineRailway, github, project, service } from "railway/iac";

export default defineRailway(() => {
  const relay = service("openwar3", {
    // The repo, and only its `server/` folder: a relay whose one dependency is `ws`. The repo
    // root's install would pull an Electron binary.
    source: github("elevchyt/openwar3", { branch: "main", rootDirectory: "/server" }),
    build: {
      builder: "RAILPACK",
      // Only a change to the relay redeploys it. A deploy drops the in-memory room table and every
      // game on the server with it, and `main` is pushed to many times a day.
      watchPatterns: ["/server/**"],
    },
    start: "node relay.mjs",
    // ONE replica, in Amsterdam. The room table lives in memory: two replicas behind Railway's
    // load balancer are two game lists, and players dealt onto different ones never meet.
    replicas: { "europe-west4-drams3a": 1 },
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      // Never asleep: a sleeping relay answers the first knock after it dozes off with a 502.
      sleepApplication: false,
    },
    env: {
      // The port the relay listens on (server/relay.mjs reads PORT) and the port the generated
      // domain `openwar3.up.railway.app` targets. IaC does not manage generated domains, so the
      // two are kept equal by hand.
      PORT: "8787",
    },
  });

  return project("openwar3", { resources: [relay] });
});
