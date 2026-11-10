## What changed

<!-- What the player (or the contributor) sees differently now. -->

## Why

<!-- The issue this closes, and the reason the old behaviour was wrong. `Fixes #123`. -->

## How it works

<!--
The mechanism in a sentence or two, and the source if the behaviour came from the game:
a file under Warcraft III/, a table in docs/wc3-data-formats.md, a reference thread from
docs/REFERENCES.md. Constants that belong to the game go in src/data/gameplayConstants.ts.
-->

## How it was tested

<!--
Paste the commands you ran and what they printed. `pnpm typecheck` and `pnpm cycles` need no
install; `pnpm sim:test` and `pnpm jass:test` need `pnpm data:extract` first. Say which ones
you ran, and say plainly if one of them could not run on your machine.
-->

```
pnpm typecheck
```

## Screenshots

<!--
For anything visible: before and after, from the running game. `(2)EchoIsles.w3x` is the
canonical test map. If you could not run the game, say so here rather than leaving it blank.
-->

## Checklist

- [ ] One logical change in this PR
- [ ] Checks that cover the change were run, and their output is above
- [ ] Visual changes carry before/after screenshots, or a note saying why they could not
- [ ] The behaviour matches Warcraft III 1.30.4, and the source for it is named in the code
- [ ] No Blizzard assets, extracted art or reference code added to the repository
