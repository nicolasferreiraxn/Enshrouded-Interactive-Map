# Changelog

*Leia em [português](CHANGELOG.pt-BR.md).*

## 1.1.1 — 2026-11-04

- **French.** The map is now available in French (Français), the 6th language: interface translated and
  game names (items, creatures, places, quests) taken from the game's official French text. Picked
  automatically when your system is in French; you can also choose it in the language menu.

## 1.1.0 — 2026-11-04

- **Monsters are back.** After the November 2026 game update (build 1285601) the map stopped showing
  creatures: the game moved the table that describes each kind of entity. The map now looks for that table
  by its content instead of at a fixed address, so the next move shouldn't break it again.
- **Unlocked doors, pressed buttons and levers, opened barriers and secret doors** are marked again; they
  depended on the same table.
- **New version notice:** on start, the map checks GitHub for a newer release and, if there is one, shows a
  banner with a link to the download page. It never downloads anything; "Dismiss" hides it until the next version.
- **Linux (Proton/Wine):** the map no longer loads its pins helper into the running game there, the step
  reported to break the map while the game runs. The live map (position, monsters, chests) keeps working; only
  syncing pins with the in-game map is unavailable, and the Pins tab says so once, in your language, instead of
  retrying forever. Not tested on Linux yet; feedback welcome.
- Technical error messages from the game connection are now in English instead of Portuguese.

## 1.0.2 — 2026-10-25

- When Windows refuses to let the map read the game (the game or Steam running as administrator), the map
  says so and offers a button to reopen it as administrator.
- Warns when the game is open but no character shows up for a while.
- Finds Steam on any drive.

## 1.0.1 — 2026-10-25

- Finds the character even when the map is opened before the game: it now waits as long as needed.

## 1.0.0 — 2026-10-24

First release: real-time map of Enshrouded on a second monitor — your position, friends, monsters, chests and
everything already done, in 5 languages, with pins synced with the in-game map.
