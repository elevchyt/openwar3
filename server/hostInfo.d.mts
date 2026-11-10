// Types for server/hostInfo.mjs, asked per connection by the dev relay
// (tools/vite-plugin-relay.ts) what this machine looks like from the network.

export interface HostInfo {
  kind: string;
  lan: boolean;
  addresses: string[];
}

export function lanAddresses(port: number): string[];

export function describeHost(kind: string, address: string, port: number): HostInfo;
