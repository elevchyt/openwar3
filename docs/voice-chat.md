# Voice chat (issue #133)

Warcraft III 1.30 has no in-game voice, so nothing here is the game's — the shape is OURS and the
developer's pick. What is reused is the game's own chat machinery.

- **Push to talk:** hold `/` (`e.code === "Slash"`, so it is the same key on every layout). LAN
  matches only — a single-player game has nobody to talk to. Ignored while typing, with a
  modifier held, and released on window blur.
- **Who hears:** the chat routing (`chatRecipients` via `voiceRecipients`, src/game/voice.ts) —
  ALLIES by default, EVERYBODY under Advanced Options → **All Talk** (`AdvancedOptions.allTalk`, the
  ninth row of the pane, hosted games only). A watcher only ever reaches the other watchers.
- **Wire:** the chat split again (src/game/matchLink.ts). `vox` goes client → host with the audio
  only; the host stamps the sender from the relay and sends `voxs` to each listener. A client is
  never sent a channel it may not hear.
- **Audio:** 16 kHz mono 8-bit µ-law (~16 KB/s a talker), base64 in the JSON transport. The
  microphone is opened on the first press and kept muted between presses
  (src/audio/voiceChat.ts). It needs a secure page (localhost/https/Electron).
- **HUD:** src/ui/voiceHud.ts, ≤ 4 plates (`VOICE_HUD_MAX`), stacked down the right edge just over
  the console. Each plate: race symbol (`UI\Glues\Loading\Backgrounds\Campaigns\<Race>Symbol.blp`)
  then the name, on a plate FILLED with the speaker's colour as the current Ally Color Mode paints
  it (`unitColor`, like a chat name) — so the plate is the team; there is no separate dot. Re-read
  every 100 ms so Alt-A repaints a live plate.
- **Test:** `tools/voice-test.cjs` (routing, µ-law, talker order).
