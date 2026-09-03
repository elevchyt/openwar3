# CASC — how a 1.30.4 install is read (issue #102)

OpenWar3 targets **Warcraft III: The Frozen Throne 1.30.4**. That version's UI is the one built
for widescreen (the console side-panels and the top bar stretch properly), which is why it is
the target — but it also dropped MPQ for **CASC**, Blizzard's NGDP content store, so the whole
asset layer had to learn a second storage. The MPQ path is kept and still mounts a legacy
MPQ-era folder unchanged; which one a picked folder is, is decided by `.build.info` beside the
exe, never asked of the player.

Read this before touching `src/vfs/casc.ts`, `src/vfs/blte.ts`, `src/vfs/mapArchive.ts`, the
install picker, or `tools/extract-data.mjs`.

---

## Nothing is addressed by name

An MPQ is a hash table from a path to some bytes: one lookup. CASC is content-addressed, and
four indirections stand between a path and its bytes. All four have to be walked before the
first file can be read.

```
.build.info            a '|'-separated table beside the exe. Its Build Key names…
Data/config/xx/yy/…    …a `key = value` build config, which names the `root` and the
                       `encoding` file by CONTENT key (CKey).
encoding               CKey (what a file's contents hash to) → EKey (what its STORED,
                       BLTE-encoded form hashes to).
Data/data/*.idx        EKey (first 9 bytes) → (data file, offset, length).
Data/data/data.NNN     the bytes: a 30-byte record header, then a BLTE payload.
```

Content addressing is the whole point of the middle step: a 1.30.4 install carries eleven
locales, and two files with identical bytes are **one** stored file, so it costs far less than
eleven times one locale.

Gotchas, each of which produces plausible-looking garbage rather than an error:

- **Endianness is mixed.** BLTE is big-endian throughout; the `.idx` entries and the data-file
  headers are little-endian. The 40-bit span offset inside an `.idx` entry is big-endian while
  the size field four bytes later is little-endian.
- **The `.idx` entry block is aligned to 16 from the start of the file**, not merely padded to
  the header's own length. `8 + headerSize` lands on 24 and the entries begin at 32. Get this
  wrong and every lookup misses, which reads as "this install is empty".
- **Each of the sixteen buckets is versioned.** `0000000009.idx` and `000000000a.idx` are the
  same bucket; only the higher one is live. Mounting a stale one resolves keys to offsets a
  later patch reused — corrupt data, not a missing file.
- **The span offset packs two fields.** The top bits are the `data.NNN` number, the low
  `segmentBits` (30) are the offset inside it.

`tools/casc-test.cjs` (`pnpm casc:test`) checks all of this against the real store, including a
pass that decodes **every** entry the root offers — the only check that would catch a stale
bucket, a truncated data file, or an encrypted BLTE chunk.

## BLTE

Every stored file is wrapped in BLTE: a header naming N chunks, then the chunks, each starting
with a one-byte mode — `N` raw, `Z` zlib, `F` a nested frame, `E` Salsa20-encrypted.

`E` is how Blizzard ships content before a patch goes live; a shipped 1.30.4 has none (verified
by decoding all 13,976 preloaded entries). `src/vfs/blte.ts` throws on one rather than returning
zeros, so a future build that does carry one says so.

Inflate is **pako, not `DecompressionStream`**: the VFS contract has a synchronous `rawBytes()`
(`src/vfs/types.ts`) and the web streams API has no sync form.

## The root is a text file, and it kept the MPQ names

Warcraft III's root is not the binary table WoW's is. It is one line per file:

```
War3.mpq:Units/UnitData.slk|bd17648d524aaab3d54f4d3affe58613|
enUS-War3Local.mpq:UI/CampaignStrings_exp.txt|ebbf1847b41e65a03f38b06422eefbe5|enUS
```

1.30 kept the MPQ **layering** in name after dropping the format. Three archives are mounted,
lowest priority first — the same shape `src/vfs/profiles.ts` describes for the MPQ era:

| CASC archive             | MPQ-era equivalent | holds |
|--------------------------|--------------------|-------|
| `Deprecated.mpq`         | —                  | art old custom maps still reference |
| `War3.mpq`               | War3 + War3x       | everything shared |
| `<locale>-War3Local.mpq` | War3xLocal         | localized text, voices, campaign maps |

Verified on the retail build: the three sets are **disjoint but for two files**, so the order
barely bites — but it is the order the paths imply, so it is the order we mount.

The locale is picked by counting which `<locale>-War3Local.mpq`'s files are actually in the
local index (an install downloads exactly one), with `.build.info`'s `Tags` column as a
tie-breaker. A tag is a claim about what was *requested*; the index is what is *there*.

Two more things live in the root and are deliberately ignored: the installer's own files (the
exes, the `.app` bundles — they carry no `<archive>:` prefix), and `Custom_V0/`, `Custom_V1/`
and `Melee_V0/` copies of the data tables, which are 1.29's game-data-set variants. The
unprefixed path is the one the engine asks for.

## What is held in memory, and what is not

`rawBytes()` is synchronous and half the engine reads through it — the SLK tables, the fonts,
the cursors, `resolveModelSounds` parsing an `.mdx` mid-combat. A `Blob` can only be read
asynchronously, so the bytes have to be resident before the first caller asks.

So the mount does one sequential sweep and pulls every non-streamed entry into memory
**compressed**, decoding on demand. For a 1.30.4 install:

| | compressed |
|---|---|
| preloaded (slk, txt, fdf, j, blp, mdx, ttf, …) | **291 MB** |
| streamed on demand (wav, mp3, avi) | 1281 MB |

That is *less* than the ~1 GB the four MPQs already cost, because audio and video — 4 files in 5
by size — are left on disk. Every one of those goes through the **async** `read()`
(`audio/sounds.ts` decodes into an `AudioBuffer`), so nothing synchronous ever asks for one.
`rawBytes()` on a streamed path returns null, deliberately, and `casc:test` asserts exactly that
split.

Decoded bytes are a bounded FIFO cache (~96 MB), not the store: a fully decoded install is
~585 MB, which is more than the compressed form it came from.

## A campaign map is not a file any more

This is the one thing that does not survive the move. `Maps\FrozenThrone\Campaign\OrcX01.w3x`
is not a blob in CASC — the installer flattened it into the store along with everything else,
so it is ~22 root entries of the form `…OrcX01.w3x:war3map.j`.

Everything downstream of the campaign screen takes a map's raw bytes: the terrain, the w3i, the
triggers, the minimap, and mdx-m3-viewer's own `loadMap`. So `src/vfs/mapArchive.ts` puts the
archive back together — `readMapBytes(vfs, path)` returns the stored `.w3x` where there is one
and a **repack** of the exploded entries where there isn't. The real 1.30 client does the same
thing (its TVFS presents those entries to the engine as one mounted archive), and it keeps the
one map path the engine has always had rather than growing a second one that only campaigns
take and only campaigns can break.

One trap in the repack: a fresh `MpqArchive`'s hash table holds **four** entries and never
grows. `set()` past that returns false and the file is silently dropped, which shows up as "this
chapter has no terrain" rather than as an error. The table is sized up front.

## Tools

| command | what it does |
|---|---|
| `pnpm casc:test` | mounts the local store and checks it end to end; skips on an MPQ install |
| `pnpm data:extract` | rebuilds `ExtractedData/` from **either** storage |
| `pnpm data:verify` | re-checks `src/data/gameplayConstants.ts` against the extracted data |

Every one of them drives the **engine's own** reader — `src/vfs/casc.ts` compiled to CommonJS by
`tools/tsconfig.casc.json` and run over `fs` (`tools/install.cjs`). A second parser for the
tools would only be a second parser to be wrong in its own way.

`by-archive/` is not written for a CASC install: shared bytes are one stored file, so the merged
view *is* the per-archive view.

## What 1.30.4 changed besides the storage

- **Six constants became natives.** 1.29 raised the player cap (1.30.4's `common.j` declares 24
  player colours), so `bj_MAX_PLAYERS`, `bj_MAX_PLAYER_SLOTS`, `bj_PLAYER_NEUTRAL_VICTIM`,
  `bj_PLAYER_NEUTRAL_EXTRA`, `PLAYER_NEUTRAL_AGGRESSIVE` and `PLAYER_NEUTRAL_PASSIVE` are now
  `GetBJMaxPlayers()`-style calls instead of literals. They are ours to answer, from
  `src/data/enums.ts`'s `PlayerSlot` (`src/jass/natives/config.ts`). Left unimplemented each
  returns a typed zero, and none of those zeroes is harmless: `PLAYER_NEUTRAL_PASSIVE = 0` hands
  every gold mine and shop to the first player, and `bj_PLAYER_NEUTRAL_VICTIM = 0` makes
  `InitBlizzard`'s first act un-ally player 0 from their own team-mates.
- **The gameplay constants did not move.** All 148 in `gameplayConstants.ts` still match.
- **Some models were re-exported.** `Footman.mdx` lost its `Attack Slam` and gained `Stand
  Defend` / `Walk Defend` / `Attack Defend`. Anything asserting on a specific clip needs
  checking against the 1.30.4 art, not remembered from an earlier patch.
