# Auto Camera (observers)

Issue #167. An observer — the Custom Game screen's Observer Mode, or a seat on a LAN game's
Observers bench (`MeleeConfig.observer`) — gets an **Auto Camera** checkbox, which the observer
HUD (issue #168, [`docs/observer-hud.md`](observer-hud.md)) stands above its selection panel,
on no panel of its own.
Ticked, the camera pans by itself to the most interesting part of the match. It starts TICKED
(`AutoCamera.enabled`) — ours, not the game's: a watcher who has not touched it wants to be shown
the match.

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

- **Heroes and armies are the focus, heroes first.** A hero counts `HERO_WEIGHT` (15) soldiers —
  it was 6, and an army of seven standing in its base outranked a hero creeping on his own; the
  developer asked for heroes to be followed rather than units. The same weight pulls an army's
  framing onto the hero marching with it. Workers, buildings and creeps count for nothing until
  something happens to them.
- **Fights first.** A unit in a fight counts `FIGHT_WEIGHT` (3) times as much, and a spot where two
  or more PLAYERS are fighting `CLASH_BONUS` (1.5) times more again. "In a fight" is `inCombat`
  (it crosses the wire) OR having lost hit points in the last `HURT_MEMORY` (3) seconds —
  measured by the camera itself off the hit points it can see, so a raid on the mine and a base
  being burned count on a LAN client as they do on the host.
- **It does not pan often.** After a pan it holds `MIN_HOLD` (7) seconds whatever starts up
  elsewhere — "there must be a delay between each pan even if the point of interest changes" —
  and a new spot must score `SWITCH_MARGIN` (1.35×) the one it is watching. Between pans it
  FOLLOWS the action it is on, which is the same point of interest and not a new pan. The
  follow is LOCKED, not eased (the developer's call): the scan remembers which units a spot is
  the centre of (`Spot.members`), and every frame the camera sits on their weighted centre where
  they stand NOW, and RIDES it the way Ctrl+C's lock rides a unit (the answer carries `ride`,
  and the renderer hands it to the same `easeFocusTo` spring, 45 ms, on the game clock). The old
  0.6 s ease trailed a marching army, and locking to the scan's own centre instead would move in
  half-second steps. A pan's end point tracks the same live centre, so the lock
  does not jump when the pan lands.
- **Brisk, and a CUT when far.** A pan is a smoothstep ease over `PAN_MIN`..`PAN_MAX`
  (0.45–1.1 s at `PAN_SPEED` 4500/s) by distance — halved from the first cut (0.9–2.4 s), which
  was too floaty. A target further than
  `SNAP_DISTANCE` (3000, the developer's figure) is cut to outright: gliding across the whole map
  shows nothing but empty ground.
- **A melee opening is a TOUR of the bases.** At 0:00 nothing weighs anything — workers and
  buildings count for nothing — so the camera stayed wherever it started and then fixed on the
  first base to train a hero, never showing the other player's build order. For the first
  `OPENING_TIME` (150) seconds of match time on a MELEE map (`meleeOpening`, set by
  `beginMatch`) it cuts between each player's base every `OPENING_DWELL` (9) seconds, starting
  with the one nearest the camera. A base is the centre of that player's buildings and workers,
  found once — a hall, its mine and five workers frames the whole economy. Only a fight between two
  PLAYERS (a clash) ends the tour early; a hero creeping does not. A custom map has no tour.
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

- `tools/auto-camera-test.cjs` (in `pnpm sim:test`) pins: heroes over a quiet base, a brisk
  pan with an eased start, the cut past `SNAP_DISTANCE`, a lone hero over an idle army, the
  opening tour (both bases turn about, a clash ends it, none on a custom map), the hold between pans (a bigger fight elsewhere waits for it; a
  flip-flopping pair of fights is not ping-ponged), following a marching army, standing aside for
  the observer's hand, and a hurt worker counting as a fight.
- Live: `?dev&map=EchoIsles&observe` seats every playable slot as a computer (at `&ai=`, Normal
  by default) and this machine as the observer (`devBoot.ts observeConfig`).
