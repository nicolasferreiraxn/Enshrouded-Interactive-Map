# Enshrouded Interactive Map

Interactive **Enshrouded** map for your second monitor. It reads the game's memory to show where you and your
friends are, and removes from the map whatever has already been picked up, opened, defeated or mined. The map is
drawn with the same shader as the in-game map (M key).

*Leia em [português](README.pt-BR.md).*

> **No support.** Published for the community to use, read and improve. There is no help desk and no release
> schedule. The license lets you take it, modify it and publish it.

## Where it came from

I looked for Enshrouded interactive maps and none of them satisfied me. So I made my own: at first, just a map
showing where everything was, with the look of the in-game map. Playing with friends on our server, I kept adding
what I was missing — my position in real time, knowing what had already been done (the chest a friend opened, the
plant already harvested, the secret door already used), friends on the map, living creatures, pins synced with the
game.

The core idea is simple: the game already knows all of that, because it needs to in order to draw the world. The
map just checks each marker against memory and removes whatever no longer exists.

## What it does

- Same map as the M key (relief, contour lines, fog), with your position and heading in real time.
- Friends on the map, with their names.
- Every marker with the game's exact text, in **5 languages**: Português, English, Español, Deutsch, 简体中文.
- Whatever has been done disappears on its own: chests, items, plants, buttons, barriers, locked and secret doors.
- Living creatures at their real position, with your target's health live.
- Depleted ore leaves the map when you finish the node.
- Item search with who drops it; **My filter** to show only what you're hunting.
- Pins synced with the in-game map: creating, deleting or renaming on one side changes the other.
- Route to any point; **F8** hides the closest point.

## How it works

**Reading.** The exe opens the game with `PROCESS_VM_READ` and reads it with `ReadProcessMemory`:

| data | source |
|---|---|
| position and camera | addresses the app finds and validates on its own at startup — usually survives game updates |
| chests, items, plants | ECS entities loaded around you (~95 m); a fixed item that vanished = picked up |
| buttons, barriers, doors | toggle, lock and interaction components |
| creatures | position and health; a spawn with no living creature leaves the map |
| ore | terrain blocks (dug + original); depleted = no group of 6+ ore blocks left |
| lore read, fog | your local save (`.ksd`), read only |

State is remembered after you walk away and the game unloads the area, so nothing pops back up for no reason.

**Pins.** To create markers on the in-game map, the exe loads an embedded DLL into the game process
(`LoadLibraryW` via `CreateRemoteThread`). It finds the game's own marker functions **by byte pattern** — if a
pattern doesn't match exactly once, it does nothing — and calls them on the game thread, receiving requests through
a local pipe. Pins are saved to your character like any marker. This is the only part that writes to the game.

## Installation

1. Download the `.zip` from [Releases](../../releases) and extract it.
2. Open `Mapa Interactive Enshrouded.exe` with the game running.

Requirements: Windows 10/11 and Enshrouded 1.0 (Steam). Tested in October 2026. A game update may break parts
until a new version comes out.

Nothing leaves your machine: no internet, telemetry or account. Filters and pending pins stay under your Windows
user.

## Languages

| text | source | file |
|---|---|---|
| game names (items, creatures, quests…) | the game's **official** text | `app/public/lang/<language>.json` |
| interface (buttons, menus, hints) | our translation | `app/src/i18n/<language>.json` |

**Want another language?** Copy `app/src/i18n/en.json` to `<code>.json`, translate the values (keep the keys),
add the language to `app/src/i18n.js` and open a pull request. We generate the game names for the new language from
the official text; until then they show in English.

## Building

Releases are built by **GitHub Actions** from this repository, with a public log
([`build.yml`](.github/workflows/build.yml)) — you can check that the binary came from this code.

Locally (Node 20+, Rust stable, Windows):

```
compilar.bat
```

| folder | contents |
|---|---|
| `app/src` | interface (React + Leaflet); the WebGL2 map is in `gamemap.js` |
| `app/src-tauri/src` | memory: `tracker.rs` (position), `live.rs` (live state), `terreno.rs` (ore), `injetor.rs` (pins) |
| `injector/marcador` | the pins DLL (built and embedded into the exe automatically) |
| `app/public` | ready-made data: markers, icons, tiles |

## Credits

- **Keen Games** — Enshrouded. Game names, map shader and textures come from the game files. Not affiliated with
  Keen Games.
- **[kfc-parser](https://github.com/Brabb3l/kfc-parser)** by brabb3l — used to read the game's resources.

Companion projects: **Enshrouded Save Editor** and
**Enshrouded Server Guardian**.

## License

Code is MIT — see [LICENSE](LICENSE). The data in `app/public` belongs to Keen Games and enshrouded.tools and is not
covered by the MIT license.
