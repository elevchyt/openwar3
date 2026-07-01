// Playable races (plan Phase 5.5). Central place for race identity + labels;
// the melee starting-unit rosters per race will be added here next.

export type Race = "human" | "orc" | "undead" | "nightelf" | "random";

export const RACES: Race[] = ["human", "orc", "undead", "nightelf", "random"];

export const RACE_LABEL: Record<Race, string> = {
  human: "Human",
  orc: "Orc",
  undead: "Undead",
  nightelf: "Night Elf",
  random: "Random",
};

// war3map.w3i player race field: 1=Human, 2=Orc, 3=Undead, 4=Night Elf.
export function raceFromW3i(n: number): Race {
  return (["random", "human", "orc", "undead", "nightelf"][n] as Race) ?? "random";
}
