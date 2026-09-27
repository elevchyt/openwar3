# Auto Camera (observers)

Issue #167. An observer — the Custom Game screen's Observer Mode, or a seat on a LAN game's
Observers bench (`MeleeConfig.observer`) — gets an **Auto Camera** checkbox under the upper
button bar, in the top-left corner where a player's hero bar hangs (an observer has no heroes).
Ticked, the camera pans by itself to the most interesting part of the match.

## The control is the game's

`UI\FrameDef\UI\ObserverPanel.fdf` already has it: `ObserverCameraCheckBox`, a SIMPLECHECKBOX
0.02 square wearing `ReplayCheckBoxNormal` / `ReplayCheckBoxPressed` / `ReplayCheckBoxCheck`
(war3skins — the per-race EscMenu checkbox art), labelled with `REPLAY_CAMERA`, which
`GlobalStrings.fdf` spells **"Auto Camera"**, in `ObserverPanelStringTemplate` (MasterFont 0.008,
gold, black drop shadow). The HUD draws exactly that (`Hud.buildAutoCameraBox`, `.hud-autocam`
in style.css). Only its PLACE is the issue's: the FDF parks the observer panel low, beside the
console.

## What it does is OURS

Nothing in the install says how the game's auto camera chooses, so every rule and number in
[`src/game/autoCamera.ts`](../src/game/autoCamera.ts) is ours, and says so:

- **Heroes and armies are the focus.** A hero counts `HERO_WEIGHT` (6) soldiers; workers,
  buildings and creeps count for nothing until something happens to them.
- **Fights first.** A unit in a fight counts `FIGHT_WEIGHT` (3) times as much, and a spot where two
  or more PLAYERS are fighting `CLASH_BONUS` (1.5) times more again. "In a fight" is `inCombat`
  (it crosses the wire) OR having lost hit points in the last `HURT_MEMORY` (3) seconds —
  measured by the camera itself off the hit points it can see, so a raid on the mine and a base
  being burned count on a LAN client as they do on the host.
- **It does not pan often.** After a pan it holds `MIN_HOLD` (7) seconds whatever starts up
  elsewhere — "there must be a delay between each pan even if the point of interest changes" —
  and a new spot must score `SWITCH_MARGIN` (1.35×) the one it is watching. Between pans it
  FOLLOWS the action it is on (a slow ease, `FOLLOW_TAU`), which is the same point of interest
  and not a new pan.
- **Smooth.** A pan is a smoothstep ease over `PAN_MIN`..`PAN_MAX` (0.9–2.4 s) by distance.
- **The observer's hand wins.** Any other move of the camera (keys, edge, minimap, a hero key)
  is noticed by the focus not being where the auto camera left it; it stands aside
  `MANUAL_GRACE` (6) seconds, then looks round afresh. `confirm` is called after the map clamp,
  so a spot near the edge the clamp pulls back is not mistaken for the observer's hand.
- **A script outranks it.** It does not run while the map's script camera is active or user
  control is off (a cinematic).

A "view" is `VIEW_RADIUS` (800) around a spot; the best spot is each weighted unit's
neighbourhood tried as a centre, its weighted centroid returned. It looks round every
`SCAN_PERIOD` (0.5 s).

## Testing

- `tools/auto-camera-test.cjs` (in `pnpm sim:test`) pins: heroes over a quiet base, a smooth
  pan with an eased start, the hold between pans (a bigger fight elsewhere waits for it; a
  flip-flopping pair of fights is not ping-ponged), following a marching army, standing aside for
  the observer's hand, and a hurt worker counting as a fight.
- Live: `?dev&map=EchoIsles&observe` seats every playable slot as a computer (at `&ai=`, Normal
  by default) and this machine as the observer (`devBoot.ts observeConfig`).
