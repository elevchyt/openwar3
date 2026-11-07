// Types for electron/mapSites.mjs, for the dev server's plugin (tools/vite-plugin-mapsite-proxy.ts).
export const MAP_SITE_MAX_BYTES: number;
export function mapSiteAllowed(url: string): boolean;
export function fetchMapSite(url: string, signal?: AbortSignal): Promise<Response>;
export function readMapSite(url: string): Promise<{ status: number; type: string; bytes: Uint8Array }>;
export const OPENABLE_HOSTS: string[];
export function mapSiteOpenable(url: string): boolean;
