// The OpenWar3 servers on Railway — every setting their services run with, as code.
//
// Railway Infrastructure as Code (docs.railway.com/infrastructure-as-code). This file is the whole
// Railway project: the relay in `server/` (docs/multiplayer.md "The OpenWar3 server (Railway)"),
// deployed THREE times — one service per region (EU, US, Asia; issue #225), each its own game
// list, because a region is a SERVICE here and never a second replica (see `relay` below).
//
// It is NOT applied on push. Apply it from a checkout that is logged in and linked to the
// project, with the Railway CLI 5.42.1 or newer:
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

/**
 * One relay service, pinned to one region. Every service is the same `server/` deployed the same
 * way; only the region (and the generated domain, which IaC does not manage) differ. The client
 * watches all three (src/net/officialServer.ts) and merges their game lists.
 */
function relay(name: string, region: string) {
  return service(name, {
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
    // ONE replica per service. The room table lives in memory: two replicas behind Railway's load
    // balancer are two game lists, and players dealt onto different ones never meet — which is
    // also why a second region is a second SERVICE with a domain of its own, never a replica.
    replicas: { [region]: 1 },
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      // Never asleep: a sleeping relay answers the first knock after it dozes off with a 502.
      sleepApplication: false,
    },
    env: {
      // The port the relay listens on (server/relay.mjs reads PORT) and the port each generated
      // domain targets. IaC does not manage generated domains, so the two are kept equal by hand.
      PORT: "8787",
    },
  });
}

export default defineRailway(() => {
  // Region identifiers: docs.railway.com/deployments/regions. The EU one is the original server
  // and the client's default; the domains are `openwar3-eu`, `openwar3-us` and `openwar3-asia`
  // `.up.railway.app` (the EU one was `openwar3.up.railway.app` until 0.3.61).
  const eu = relay("openwar3-eu", "europe-west4-drams3a");       // EU West, Amsterdam
  const us = relay("openwar3-us", "us-east4-eqdc4a");           // US East, Virginia
  const asia = relay("openwar3-asia", "asia-southeast1-eqsg3a"); // Southeast Asia, Singapore

  return project("openwar3", { resources: [eu, us, asia] });
});
