# V2 Data Source Findings — pogoapi.net & pokemon-go-api

Phase 0 spike output (see [roadmap.md](roadmap.md) §3). Scope was widened
beyond Pokémon species/forms on purpose: V2 also wants player level, medals,
friendship, battle league, and other non-species reference data, so both
sources were surveyed for that too, not just dex data.

---

## 1. Summary

| Source | Breadth | Verdict |
| :--- | :--- | :--- |
| **pogoapi.net** | Wide — 45 endpoints spanning species, moves, raids, events, and a full player-progression tier (XP, levels, badges/medals, friendship, battle league) | Strong candidate to replace the current PokeAPI+CSV+wikitext pipeline for species/forms, **and** the only one of the two that covers non-Pokémon data we need for V2 |
| **pokemon-go-api** (pokemon-go-api/pokemon-go-api) | Narrow — GameMaster-sourced species/forms, raid bosses, Max Battles, plus generated raid-graphic images | No player progression, medals, items, moves, or PvP endpoints found in the README or docs site. Coverage looks like a subset of pogoapi.net's species/raid data, in a different shape |

**Reading:** pogoapi.net alone gets us both goals — cleaner species/form
ingestion and the previously-uncovered player-progression data. pokemon-go-api
doesn't add anything pogoapi.net doesn't already have for our stated V2 needs;
its main distinguishing feature (generated raid-graphic PNGs) isn't something
we currently use. Recommend treating pogoapi.net as primary and
pokemon-go-api as unnecessary unless a gap turns up during actual
implementation.

---

## 2. pogoapi.net — Full Endpoint Catalog

45 endpoints under `/api/v1/`, grouped by category.

### Pokémon Species

| Endpoint | Contains |
| :--- | :--- |
| `pokemon_names.json` | ID → name / basic identity mapping |
| `released_pokemon.json` | Species currently available in-game |
| `nesting_pokemon.json` | Species that nest at specific location types |
| `shiny_pokemon.json` | Shiny availability method (wild, raid, egg, evolution, research, photobomb) |
| `possible_ditto_pokemon.json` | Species that may be a disguised Ditto |
| `pokemon_stats.json` | Base attack / defense / stamina |
| `pokemon_max_cp.json` | Max CP at level 40, perfect IVs |
| `pokemon_candy_to_evolve.json` | Candy cost per evolution stage |
| `pokemon_types.json` | Type assignments |
| `pokemon_rarity.json` | Standard / Legendary / Mythic classification |
| `pokemon_genders.json` | Gender ratio, incl. genderless |
| `pokemon_generations.json` | Generation number per species |
| `shadow_pokemon.json` | Species obtainable as Shadow (Team Rocket) |
| `pvp_exclusive_pokemon.json` | Species only obtainable via PvP rewards |
| `research_task_exclusive_pokemon.json` | Species only obtainable via research tasks |
| `pokemon_height_weight_scale.json` | Height/weight, incl. XS/XL thresholds |
| `baby_pokemon.json` | Egg-hatch-only species |
| `time_limited_shiny_pokemon.json` | Species with event-only shiny windows |
| `photobomb_exclusive_pokemon.json` | Species only obtainable via photobomb |
| `pokemon_evolutions.json` | Evolution trees incl. item/condition requirements |

### Pokémon Forms

| Endpoint | Contains |
| :--- | :--- |
| `alolan_pokemon.json` | Species with an Alolan form |
| `galarian_pokemon.json` | Species with a Galarian form |
| `pokemon_forms.json` | Form variants (Normal, Alola, Shadow, Purified, etc.) |
| `mega_pokemon.json` | Mega Evolution forms, energy cost, stat bonuses |

### Moves

| Endpoint | Contains |
| :--- | :--- |
| `fast_moves.json` | Fast move power / duration / energy gain |
| `charged_moves.json` | Charged move power / critical chance |
| `current_pokemon_moves.json` | Per-species move pools incl. legacy/Elite-TM moves |
| `pvp_fast_moves.json` | Fast moves with PvP turn-duration data |
| `pvp_charged_moves.json` | Charged moves with PvP buffs/debuffs |

### Raids

| Endpoint | Contains |
| :--- | :--- |
| `raid_exclusive_pokemon.json` | Species mapped to raid tier |
| `raid_bosses.json` | Current + historical raid boss lineups by tier |
| `raid_settings.json` | Lobby size, invite, and remote-raid config |

### Battles / Gameplay Mechanics

| Endpoint | Contains |
| :--- | :--- |
| `type_effectiveness.json` | Attack/defense type damage multipliers |
| `weather_boosts.json` | Weather → boosted type mapping |
| `cp_multiplier.json` | Level → CP multiplier table |
| `pokemon_buddy_distances.json` | Walking distance to earn candy per buddy |
| `pokemon_encounter_data.json` | Capture rate, flee rate, base battle stats |
| `pokemon_powerup_requirements.json` | Stardust + candy per power-up level |
| `mega_evolution_settings.json` | Mega Energy mechanics, attack bonus rules |

### Player Progression — not covered by our current pipeline at all

| Endpoint | Contains |
| :--- | :--- |
| `player_xp_requirements.json` | Cumulative XP required per player level (1–50) |
| `levelup_rewards.json` | Items/unlocks granted at each player level |
| `badges.json` | Achievement medals — tiers, milestones, event-linked medals |
| `friendship_level_settings.json` | Friendship tiers and their trade/raid/XP benefits |

### PvP

| Endpoint | Contains |
| :--- | :--- |
| `gobattle_league_rewards.json` | Battle League rank rewards, free + premium track |
| `gobattle_ranking_settings.json` | Rank thresholds, rating display rules |

### Events

| Endpoint | Contains |
| :--- | :--- |
| `community_days.json` | Community Day dates, bonuses, boosted species, exclusive move |

### Infrastructure

| Endpoint | Contains |
| :--- | :--- |
| `api_hashes.json` | Per-file content hash — useful for our own stale-cache/change-detection needs |

---

## 3. pokemon-go-api — Findings

Much narrower than pogoapi.net; README and docs site describe:

| Data | Contains |
| :--- | :--- |
| Pokémon species/forms | Sourced from the game's GameMaster file via PokeMiners — stats and properties, similar territory to pogoapi.net's species tables but a different JSON shape |
| Raid bosses | Current raid tiers, incl. `shadow_lvl1`/`shadow_lvl3`/`shadow_lvl5` and `ultra_beast` categories not seen broken out this way in pogoapi.net |
| Max Battles | Current Max Battle roster (added Dec 2025) — pogoapi.net has no equivalent endpoint today |
| Raid graphics | Auto-generated localized PNG raid-boss graphics (German/English) — a rendering feature, not raw data |

No endpoints found for: player XP/level, medals/badges, friendship, items,
move databases, PvP rankings, or events. The README explicitly doesn't
document any of these; the underlying GameMaster file may contain fragments
of it, but nothing is exposed as a stable endpoint the way pogoapi.net does.

**Two things pokemon-go-api has that pogoapi.net doesn't:** live Max Battles
data, and the shadow-raid-tier breakout. Worth keeping in mind if Max Battles
or shadow raids become a tracked feature later — otherwise not a reason to
adopt it as a primary source.

---

## 4. Comparison to Current Ingestion

Our current pipeline (PokeAPI + Forms CSV + Gigantamax file + Bulbapedia
wikitext, per [ingestion-runbook.md](ingestion-runbook.md)) only ever
targeted species/form/costume reference data. Everything in pogoapi.net's
**Player Progression** and **PvP** categories above is entirely new ground —
none of it has any equivalent in our schema or pipeline today. That's the
concrete data behind the roadmap's "player level, medals, and a ton of other
things" goal.

Not evaluated in this pass, deferred to actual implementation:
- Exact field-level diff between pogoapi.net's species tables and our
  existing `reference.json` shape.
- Data freshness/update cadence for both sources (neither page states an
  update SLA).
- Licensing/attribution requirements for either source.

---

## 5. Correction: Sprites — pogoapi.net does NOT have them

Checked directly against the live API (all 45 endpoint payloads pulled and
inspected): **no endpoint returns an image URL, sprite field, or icon field
of any kind.** Grepping every downloaded payload for `http…png/jpg/svg`,
`sprite`, `image`, and `icon` keys returned nothing. pogoapi.net is data-only.

The sprite capability actually belongs to **pokemon-go-api**, specifically
its companion repo
[`pokemon-go-api/assets`](https://github.com/pokemon-go-api/assets) (linked
from the main repo's README, not documented in the main API itself) — a
~90MB image repo with a clear naming convention:

```text
Pokemon/pm{pokemon_id}.icon.png              — base form
Pokemon/pm{pokemon_id}.s.icon.png             — shiny variant (.s.)
Pokemon/pm{pokemon_id}.f{FORM}.icon.png       — form variant (e.g. pm100.fHISUIAN.icon.png)
Pokemon/pm{pokemon_id}.c{COSTUME}.icon.png    — costume variant (e.g. pm1.cFALL_2019.icon.png)
```

This is a maintained, ID-keyed sprite manifest with costume and shiny
coverage — a real alternative to our current hand-maintained
`form-sprite-slugs.json` + manual sprite handling. **Recommendation:**
pogoapi.net for data breadth, `pokemon-go-api/assets` for sprites — not an
either/or between the two projects. Not yet checked: license terms, update
cadence, or full coverage vs. our current sprite set.

---

## 6. Costume Data — confirmed present, in pogoapi.net's `form` field

Every per-species-and-form endpoint (`pokemon_stats`, `pokemon_types`,
`current_pokemon_moves`, `pokemon_encounter_data`, `pokemon_height_weight_scale`,
`pokemon_max_cp`, `pokemon_genders`, `pokemon_rarity`) is keyed by
`(pokemon_id, form)`, and costume events show up as their own `form` values
alongside real forms (Alolan, Galarian, Mega, etc.) — there's no separate
"is this a costume" flag, but the values are unambiguous. Example: Pikachu
alone carries 50 form entries in `pokemon_stats.json`, including
`Pop_star`, `Rock_star`, `Doctor`, `Horizons`, `Gofest_2022`,
`Wcs_2022`/`2023`/`2024`/`2025`, several `Summer_2023_*` and `Gotour_2024_*`
variants, `Kariyushi`, `Jeju`, and more — this is the same event-costume
territory our current Bulbapedia-wikitext ingestion step targets, but
already structured as data rather than scraped wikitext.

Not yet resolved: whether pogoapi.net's costume-form names line up cleanly
with our existing costume slugs, or need a mapping table — a real field-level
diff is deferred to implementation, per §4 above.

---

## 7. Sample Payloads (all 45 pogoapi.net endpoints)

One to two real records from each endpoint, pulled directly from the live
API, to ground reference-table design. Full raw JSON retained in the
research scratchpad, not committed to the repo — these excerpts are enough
to design table shape.

### Pokémon Species

**`pokemon_names.json`** (dict, 1025 keys)
```json
{ "1": { "id": 1, "name": "Bulbasaur" } }
```

**`released_pokemon.json`** (dict, 937 keys) — same shape as `pokemon_names`, just a smaller filtered set.

**`pokemon_stats.json`** (list, 1420 items — includes one row per (species, form))
```json
{
  "base_attack": 118, "base_defense": 111, "base_stamina": 128,
  "form": "Normal", "pokemon_id": 1, "pokemon_name": "Bulbasaur"
}
```

**`pokemon_types.json`** (list, 1420 items)
```json
{ "form": "Normal", "pokemon_id": 1, "pokemon_name": "Bulbasaur", "type": ["Grass", "Poison"] }
```

**`pokemon_rarity.json`** (dict keyed by rarity tier, e.g. `"Legendary"`)
```json
{ "form": "Galarian", "pokemon_id": 144, "pokemon_name": "Articuno", "rarity": "Legendary" }
```

**`pokemon_genders.json`** (dict keyed by ratio bucket, e.g. `"0M_1F"`)
```json
{ "form": "Diwali_2024", "gender": { "female_percent": 1.0 }, "pokemon_id": 25, "pokemon_name": "Pikachu" }
```

**`pokemon_generations.json`** (dict keyed by `"Generation N"`)
```json
{ "generation_number": 1, "id": 1, "name": "Bulbasaur" }
```

**`pokemon_height_weight_scale.json`** (list, 1355 items)
```json
{
  "buddy_scale": 19.0, "form": "Normal", "height_standard_deviation": 0.0875,
  "model_height": 0.7, "model_scale": 0.89, "pokedex_height": 0.7,
  "pokedex_weight": 6.9, "pokemon_id": 1, "pokemon_name": "Bulbasaur",
  "weight_standard_deviation": 0.8625
}
```

**`pokemon_max_cp.json`** (list, 1420 items)
```json
{ "form": "Normal", "max_cp": 1275, "pokemon_id": 1, "pokemon_name": "Bulbasaur" }
```

**`pokemon_candy_to_evolve.json`** (dict keyed by candy amount)
```json
{ "candy_required": 100, "form": "Normal", "pokemon_id": 2, "pokemon_name": "Ivysaur" }
```

**`pokemon_evolutions.json`** (list, 532 items)
```json
{
  "evolutions": [{ "candy_required": 25, "form": "Normal", "pokemon_id": 2, "pokemon_name": "Ivysaur" }],
  "form": "Normal", "pokemon_id": 1, "pokemon_name": "Bulbasaur"
}
```

**`shiny_pokemon.json`** (dict keyed by species ID)
```json
{
  "found_egg": true, "found_evolution": false, "found_photobomb": true,
  "found_raid": true, "found_research": true, "found_wild": true,
  "id": 1, "name": "Bulbasaur"
}
```

**`shadow_pokemon.json`**, **`possible_ditto_pokemon.json`**, **`baby_pokemon.json`**,
**`research_task_exclusive_pokemon.json`**, **`pvp_exclusive_pokemon.json`**,
**`photobomb_exclusive_pokemon.json`**, **`time_limited_shiny_pokemon.json`** —
all small lookup lists/dicts of `{ id, name[, form] }`, i.e. "is this species
in category X" membership sets.

### Pokémon Forms

**`alolan_pokemon.json`**, **`galarian_pokemon.json`** (dicts keyed by species ID) — `{ "id": 103, "name": "Exeggutor" }`, membership sets like above.

**`pokemon_forms.json`** (list, 273 items) — **not species-keyed** — a flat vocabulary of every form-name token used across the other endpoints (`"Alola"`, `"Costume_2020"`, `"Gofest_2024_mscarf"`, `"Crowned_shield"`, etc.). Useful as a form-name dictionary, not per-species data.

**`mega_pokemon.json`** (list, 48 items)
```json
{
  "first_time_mega_energy_required": 200, "form": "Normal",
  "mega_energy_required": 40, "mega_name": "Mega Venusaur",
  "pokemon_id": 3, "pokemon_name": "Venusaur",
  "stats": { "base_attack": 241, "base_defense": 246, "base_stamina": 190 },
  "type": ["Grass", "Poison"]
}
```

### Moves

**`fast_moves.json`** / **`charged_moves.json`** (lists, 77 / 240 items)
```json
{ "duration": 500, "energy_delta": 8, "move_id": 200, "name": "Fury Cutter", "power": 4, "stamina_loss_scaler": 0.01, "type": "Bug" }
```

**`pvp_fast_moves.json`** / **`pvp_charged_moves.json`** (lists, 80 / 233 items) — same shape, PvP-specific fields (`turn_duration`, `buffs`) instead of `stamina_loss_scaler`.

**`current_pokemon_moves.json`** (list, 1420 items)
```json
{
  "charged_moves": ["Sludge Bomb", "Seed Bomb", "Power Whip"],
  "elite_charged_moves": [], "elite_fast_moves": [],
  "fast_moves": ["Vine Whip", "Tackle"],
  "form": "Normal", "pokemon_id": 1, "pokemon_name": "Bulbasaur"
}
```

### Raids

**`raid_bosses.json`** (dict with `"current"` key, nested by tier)
```json
{
  "boosted_weather": ["Fog", "Windy"], "form": "Normal", "id": 633,
  "max_boosted_cp": 758, "max_unboosted_cp": 606, "min_boosted_cp": 701,
  "min_unboosted_cp": 560, "name": "Deino", "possible_shiny": true,
  "tier": 1, "type": ["Dark", "Dragon"]
}
```

**`raid_exclusive_pokemon.json`** (dict keyed by species ID) — `{ "id": 144, "name": "Articuno", "raid_level": 5 }`.

**`raid_settings.json`** (dict, 13 keys, flat config) — `{ "friend_invite_cooldown_duration": 30000, "friend_invite_cutoff_time": 20 }`.

### Battles / Gameplay Mechanics

**`type_effectiveness.json`** (dict keyed by attacking type, values = multiplier per defending type)
```json
{ "Bug": { "Bug": 1.0, "Dark": 1.6, "Dragon": 1.0, "...": "..." } }
```

**`weather_boosts.json`** (dict keyed by weather) — `{ "Clear": ["Grass", "Ground", "Fire"] }`.

**`cp_multiplier.json`** (list, 89 items, half-levels included) — `{ "level": 1, "multiplier": 0.09399999678134918 }`.

**`pokemon_buddy_distances.json`** (dict keyed by distance-km bucket, e.g. `"1"`) — lists of `{ distance, form, pokemon_id, pokemon_name }`.

**`pokemon_encounter_data.json`** (list, 1192 items)
```json
{
  "attack_probability": 0.1, "base_capture_rate": -1.0, "base_flee_rate": -1.0,
  "dodge_probability": 0.15, "form": "Normal",
  "max_pokemon_action_frequency": 1.6, "min_pokemon_action_frequency": 0.2,
  "pokemon_id": 1, "pokemon_name": "Bulbasaur"
}
```
(Note: capture/flee rate showing `-1.0` for this species in the live pull — likely "not set" rather than a real rate; worth checking during implementation.)

**`pokemon_powerup_requirements.json`** (dict keyed by current level, half-levels included)
```json
{ "candy_to_upgrade": 1, "current_level": 1, "level_after_powering": 1.5, "stardust_to_upgrade": 200, "xl_candy_to_upgrade": 0 }
```

**`mega_evolution_settings.json`** (dict, 6 keys, flat config) — `{ "general_attack_boost": 1.1, "max_mega_candy": 9999 }`.

### Player Progression

**`player_xp_requirements.json`** (dict keyed by level, 50 keys) — `{ "1": 0, "2": 1000 }` (cumulative XP).

**`levelup_rewards.json`** (list, 67 items)
```json
{ "items_received": [{ "amount_received": 10, "item": "Poké Ball" }, { "amount_received": 6, "item": "Nanab Berry" }], "level": 2 }
```

**`badges.json`** (list, 597 items — this is the medal data)
```json
{
  "description": "Achieve a seven-day Pokémon catch streak or PokéStop spin streak {0} times.",
  "event_badge": false, "name": "Triathlete", "rank": 5, "targets": [1, 10, 50, 100]
}
```
Event-linked badges have no `targets` array, just a description tied to the event (e.g. `"description": "Jeju Island, 2023"`).

**`friendship_level_settings.json`** (list, 5 items)
```json
{
  "allowed_trades": ["Regular Pokémon in Pokédex"], "attack_bonus": 1.0,
  "friendship_level": 0, "friendship_points_required": 0, "name": "Friend",
  "raid_ball_bonus": 0, "trading_discount": 0, "xp_reward": 1500
}
```

### PvP

**`gobattle_league_rewards.json`** (dict keyed by rank, 24 keys)
```json
{ "free": [{ "amount": 300, "type": "stardust" }, { "type": "pokemon_from_pool" }, { "amount": 3, "item_name": "Rare Candy", "type": "item" }], "premium": ["..."], "rank": 1 }
```

**`gobattle_ranking_settings.json`** (dict, 3 keys) — `min_rank_to_display_rating` plus a `rank_requirements` list of battle/win thresholds per rank.

### Events

**`community_days.json`** (list, 80 items — full historical record back to CD #1)
```json
{
  "bonuses": ["Double XP"], "boosted_pokemon": ["Pikachu"],
  "community_day_number": 1, "end_date": "2018-01-20",
  "event_moves": [{ "move": "Surf", "move_type": "charged", "pokemon": "Pikachu" }],
  "start_date": "2018-01-20"
}
```

### Infrastructure

**`api_hashes.json`** (dict keyed by filename) — md5/sha1/sha256 per endpoint file, directly usable for our own stale-cache detection the way `reference_data_version` works today.

---

## 8. Cross-Source Identity Risk — confirmed, not hypothetical

pogoapi.net and `pokemon-go-api/assets` are unrelated projects with **no
shared vocabulary for form/costume names.** Checked directly: pogoapi.net's
`pokemon_stats.json` lists Pikachu's costume forms as `Pop_star`,
`Rock_star`, `Doctor`, `Horizons`, `Gofest_2022`, `Wcs_2022`/`2023`/`2024`,
`Kariyushi`, `Jeju`, `Summer_2023_a`..`e`, etc. — pogoapi.net's own
normalized names. The assets repo's file tree for the same species
(`Pokemon/pm25.*`) uses a completely different token set, evidently closer to
Niantic's raw GAME_MASTER costume IDs: `COSTUME_1`, `COSTUME_2`,
`ANNIVERSARY`, `ANNIVERSARY_2022_NOEVOLVE`, `HALLOWEEN_2017`,
`HOLIDAY_2016`, `GOTOUR_2023_BANDANA_NOEVOLVE`, `INDONESIA_2025_NOEVOLVE`.
Neither the names nor the ordering give an obvious 1:1 mapping — e.g. it's
not clear from the strings alone which assets-repo token corresponds to
pogoapi.net's `Doctor` or `Pop_star`.

This means **a name-based join between the two sources will not work
out of the box.** Sprites can't just be looked up by reusing pogoapi.net's
`form` string against the assets repo's filenames — a crosswalk/mapping
table between the two vocabularies is required, built by pairing them up
(likely by release date + event context, cross-checked visually against the
actual sprite images) rather than derived automatically. This is the same
kind of manual-mapping cost our current Bulbapedia-wikitext costume step
already pays — it doesn't go away by switching sources, it just moves.

Two more dimensions the assets filenames carry that pogoapi.net's `form`
field doesn't: a `.g2.` variant (a second rendering/generation of the sprite
for the same costume — meaning likely two costume art passes exist for some
entries) and the `.s.` shiny suffix (independent of form/costume, applies
uniformly). Neither is understood yet — deferred to implementation.

---

## 9. Prerequisites Before Building the New Ingestion Pipeline

Concrete, checkable items — not design decisions — needed before writing
pipeline code, so the pipeline is built against verified facts rather than
assumptions:

1. **Form/costume crosswalk.** Build a mapping table between pogoapi.net's
   `form` strings and the assets repo's `f{FORM}`/`c{COSTUME}` filename
   tokens, for at least the species we currently track costumes for. Confirm
   whether this can be done systematically (e.g. by release-date ordering) or
   needs to stay a hand-maintained table like our current costume lookup.
2. **Coverage diff, species/forms.** Compare pogoapi.net's `released_pokemon.json`
   (937 species) and `pokemon_stats.json`'s 1420 (species, form) rows against
   our current 1024-species dataset and its form count — find species/forms
   we track that pogoapi.net doesn't cover, and vice versa.
3. **Sprite coverage diff.** For the same species/form/costume set, confirm
   the assets repo actually has an icon for every combination we need — check
   for gaps, especially older costumes and the newest ones (upload lag).
4. **Old PokeAPI (pokeapi.co) role check.** Confirm what pokeapi.co gives us
   today that pogoapi.net does not — likely candidates: official main-series
   artwork/sprites (different art style than GO's in-game models, not a
   substitute), Pokédex flavor text, and non-GO-specific taxonomy. If nothing
   pogoapi.net lacks turns up, pokeapi.co likely drops out of the pipeline
   entirely rather than becoming a third source to reconcile.
5. **License/attribution terms** for pogoapi.net, `pokemon-go-api` /
   `pokemon-go-api/assets`, and (for comparison) our current pokeapi.co usage
   — this app bundles reference data and sprites directly into the binary, so
   redistribution rights matter, not just API access.
6. **Update cadence for each source**, including the assets repo's own
   `.last_updated_pokemon_images` marker file — needed to design how the new
   pipeline detects staleness (pogoapi.net's `api_hashes.json` already gives
   us hash-based diffing for its own data; the assets repo needs an
   equivalent check).
7. **New-table shape sketch.** Before writing ingestion code, sketch the
   target schema for the genuinely new categories this data unlocks —
   player-progression (`player_xp_requirements`, `levelup_rewards`, `badges`,
   `friendship_level_settings`), PvP (`gobattle_league_rewards`,
   `gobattle_ranking_settings`), and battle mechanics (moves, `type_effectiveness`,
   `weather_boosts`, `cp_multiplier`, raid data, `community_days`) — so the
   pipeline has concrete tables to populate rather than being designed
   speculatively.

Items 1–4 are comparison/verification work (checking what's real); 5–6 are
source-diligence; 7 is the actual new-table design step, and should come
after 1–6 are answered so the schema reflects verified data, not assumptions.

---

## 10. Resolution: `pokemon-go-api`'s main API already joins forms, costumes, and sprites

Checked the live API (`pokemon-go-api.github.io/pokemon-go-api/api/pokedex/...`),
not just the assets repo — `pokemon-go-api`'s own Pokémon records carry
sprite URLs directly, pre-joined to the same form/costume tokens used in its
filenames, because it generates both from the same GameMaster source. Example
(Pikachu, `id=25`):

```json
{
  "id": "PIKACHU",
  "formId": "PIKACHU",
  "dexNr": 25,
  "assets": {
    "image": "https://raw.githubusercontent.com/pokemon-go-api/assets/main/Pokemon/pm25.icon.png",
    "shinyImage": ".../pm25.s.icon.png"
  },
  "assetForms": [
    {
      "form": null,
      "costume": "COSTUME_1",
      "isFemale": false,
      "image": ".../pm25.cCOSTUME_1.icon.png",
      "shinyImage": ".../pm25.cCOSTUME_1.s.icon.png"
    }
  ]
}
```

Regional forms come back the same way, keyed under `regionForms` (e.g.
`MEOWTH_ALOLA` → its own `formId`, `stats`, `primaryType`, sprite `assets`,
all self-contained). Evolutions reference the target by `id`/`formId` +
candy cost. Mega/raid data is populated the same way — `raidboss.json`'s
`currentList.mega` entries carry `id`, `form`, `costume`, `assets.image`, and
`dexNr`-joinable identity, no separate lookup needed.

**Net effect: §8's crosswalk problem goes away entirely if `pokemon-go-api`
is the source for species/forms/costumes/sprites.** It doesn't need to be
matched against a second vocabulary because it never used two — the API and
the asset filenames are generated from the same internal IDs. Revised
sourcing split, superseding the "either/or" framing above:

- **`pokemon-go-api`** → species, regional forms, costumes, Mega/Gigantamax
  forms, sprites (regular + shiny, base + costume), and its own raid boss
  list — all pre-joined, no crosswalk needed.
- **pogoapi.net** → everything with no species-identity ambiguity: player
  progression (XP, levels, medals, friendship), PvP league rewards/ranking,
  move stats, type effectiveness, weather boosts, CP multiplier, buddy
  distances, capture/flee rates, power-up costs, community-day history.
- Where both sources describe the same species-linked concept (e.g. both
  have *a* raid boss list, both have *a* Mega Evolution concept), prefer
  `pokemon-go-api`'s version since it's already sprite-linked; pogoapi.net's
  overlapping entries (`raid_bosses.json`, `mega_pokemon.json`) become
  comparison/backfill data rather than a primary source.
- Numeric join key confirmed available on both sides for anything that still
  needs cross-referencing between the two sources: `pokemon-go-api`'s
  `dexNr` and pogoapi.net's `pokemon_id` are the same National Dex number —
  a plain numeric join, not a string-vocabulary problem like forms/costumes
  were.

---

## 11. Gigantamax Discrepancy — full diff

Per the [full-pull coverage test](v2-pokemon-go-api-full-pull.md): we
currently flag 32 species `canGigantamax`; `pokemon-go-api` flags 15
`hasGigantamaxEvolution`. All 15 of theirs are a subset of our 32 — nothing
in their list is missing from ours, but 17 of ours aren't in theirs.

| # | Dex | Species | In ours (32) | In `pokemon-go-api` (15) |
| :-: | :-: | :--- | :-: | :-: |
| 1 | 3 | Venusaur | ✅ | ✅ |
| 2 | 6 | Charizard | ✅ | ✅ |
| 3 | 9 | Blastoise | ✅ | ✅ |
| 4 | 12 | Butterfree | ✅ | ✅ |
| 5 | 25 | Pikachu | ✅ | ❌ |
| 6 | 52 | Meowth | ✅ | ❌ |
| 7 | 68 | Machamp | ✅ | ✅ |
| 8 | 94 | Gengar | ✅ | ✅ |
| 9 | 99 | Kingler | ✅ | ✅ |
| 10 | 131 | Lapras | ✅ | ✅ |
| 11 | 133 | Eevee | ✅ | ❌ |
| 12 | 143 | Snorlax | ✅ | ✅ |
| 13 | 569 | Garbodor | ✅ | ✅ |
| 14 | 809 | Melmetal | ✅ | ❌ |
| 15 | 812 | Rillaboom | ✅ | ✅ |
| 16 | 815 | Cinderace | ✅ | ✅ |
| 17 | 818 | Inteleon | ✅ | ✅ |
| 18 | 823 | Corviknight | ✅ | ❌ |
| 19 | 826 | Orbeetle | ✅ | ❌ |
| 20 | 834 | Drednaw | ✅ | ❌ |
| 21 | 839 | Coalossal | ✅ | ❌ |
| 22 | 841 | Flapple | ✅ | ❌ |
| 23 | 842 | Appletun | ✅ | ❌ |
| 24 | 844 | Sandaconda | ✅ | ❌ |
| 25 | 849 | Toxtricity | ✅ | ✅ |
| 26 | 851 | Centiskorch | ✅ | ❌ |
| 27 | 858 | Hatterene | ✅ | ❌ |
| 28 | 861 | Grimmsnarl | ✅ | ✅ |
| 29 | 869 | Alcremie | ✅ | ❌ |
| 30 | 879 | Copperajah | ✅ | ❌ |
| 31 | 884 | Duraludon | ✅ | ❌ |
| 32 | 892 | Urshifu | ✅ | ❌ |

Pattern worth noting: the 15 that match are exactly the "original" G-max
wave (Gen 1 partners + the initial Gen 8 G-max roster), while the 17 marked
✅/❌ split roughly along "released later" or "event/regional-gated" lines
(Pikachu/Meowth/Eevee G-max were event-exclusive cap-only variants; Melmetal
G-max was a limited Community Day-adjacent release; the rest are
later-wave Gen 8 G-max species). Consistent with the roadmap's existing
theory that our 32 is the full canonical list while a real source reflects
actual in-game rollout — but the exact cutoff logic (event-gated vs.
simply-not-added-yet vs. `pokemon-go-api` lagging reality) still needs a
manual sanity check before this replaces our current data.

---

## 12. Addendum (2026-07-29) — pogoapi.net dropped; GAME_MASTER + pokemongo-shiny is the shipped source

The species/form/moves/player-progression/PvP re-sourcing work this doc's
Phase 0 spike scoped out has since actually shipped (the ingestion
consolidation branch — `scripts/ingest/sources/game-master.ts`,
`transform/*.ts`). This section records the two findings from that build
that supersede §§1–11 above rather than editing them in place, per this
repo's "archive obsolete info, don't let it drift" documentation rule.

**pogoapi.net confirmed stale, not just theoretically supersedable.** The
spike above (§1) treated pogoapi.net as the strong candidate on breadth
grounds; building against it directly surfaced that its shadow-availability
list is now materially out of date. Checked directly this session: the
vendored `vendor/pogoapi-snapshot/shadow_pokemon.json` snapshot (dict keyed
by National Dex number, per §7's sample payload) lists 245 species as
Shadow-eligible; the live GAME_MASTER dump
(`scripts/ingest/.cache-v2/game-master/GAME_MASTER.json`, ~18.7k entries)
marks 467 species Shadow-eligible via `pokemonSettings[].shadow` presence
per form (see `shadowAvailableFor` in `scripts/ingest/transform/species.ts`).
Joined on the numeric dex-number key both sides actually share — GAME_MASTER's
`pokemonId` resolved to a dex number via the cached `pgapi/pokedex.json`'s
`id`→`dexNr` mapping, per §10's "prefer the numeric join key, not a
string-vocabulary join" finding, not a display-name string match — gives
exactly **222 species GAME_MASTER shows as Shadow-eligible that the
pogoapi.net snapshot has no record of at all** (Caterpie, Metapod,
Butterfree, Pidgey, Pidgeotto, Pidgeot, Mankey, Primeape, Tentacool,
Tentacruel, Ponyta, Rapidash, Farfetch'd, Seel, Dewgong, and so on — a broad,
unpatterned mix, not one release wave). The reverse direction confirms this
is a pure staleness gap, not a vocabulary mismatch: every one of the 245
vendored dex numbers is also in GAME_MASTER's 467-species shadow set (zero
species the vendored snapshot has that GAME_MASTER doesn't). The snapshot
was vendored onto this branch fresh from a live pogoapi.net pull
(`2dfdc514`, "Vendor a full pogoapi.net snapshot (all 47 endpoints)",
2026-07-28) — so this 222-species gap is pogoapi.net's actual current state,
not a stale copy of it. No acquisition-method breakdown (wild/raid/
Rocket-only, etc.) is available from either GAME_MASTER (its `shadow` block
carries only purification cost/move fields, no method) or the
pokemongo-shiny sheet (`scripts/ingest/.cache-v2/shiny-sheet.json`'s fields
are `family_dex`/`debut`/`pid`/`group`/`tag`/`order`/`suffix` — no method
field either, and it's shiny-scoped, not shadow-scoped) that replaced
pogoapi.net's `shiny_pokemon.json` for shiny data — that finer-grained field
simply isn't part of the sourcing swap; only availability (yes/no) carried
over.

**Sourcing decision that replaced it**: species/forms/gender/shadow
availability now come from GAME_MASTER (`alexelgt/game_masters`) directly,
and shiny availability/debut dates come from the pokemongo-shiny community
sheet (`shiny.debut`), not pogoapi.net's `shiny_pokemon.json` presence
check — see `scripts/ingest/transform/species.ts`'s `shadowAvailableFor`
and the `ShinyLookup` docstring in `scripts/ingest/sources/game-master.ts`
for the field-level reasoning (in particular why shiny sourcing moved off
sprite-presence: Eternatus has a shiny sprite in `pokemon-go-api`'s assets
but is not actually shiny-released, which a presence check alone would get
wrong). Both are load-bearing choices `docs/ingestion-runbook.md` and
`docs/architecture.md`'s Scripts table now document as the live pipeline,
not a proposal.

**Medal data resolution.** A related gap surfaced during the same build:
GAME_MASTER's `badgeSettings` carries no medal display name or description
text at all — confirmed by direct inspection of the raw dump (a
`badgeSettings` record has only `badgeType`, `badgeRank`, and `targets`;
no `name`/`description` field exists anywhere in the category). pogoapi.net
was the prior source for that text, but per the staleness finding above
isn't trustworthy for a live fetch, and never published a badge id to join
on regardless. The resolution: a **committed, one-time vendored snapshot**
(`vendor/pogoapi-snapshot/badges.json`, 597 entries) supplies just the
name/description strings, joined against live GAME_MASTER `badgeSettings`
via a subsequence-alignment algorithm
(`scripts/ingest/sources/pogoapi-badges.ts`'s `alignVendorBadges`) that
tolerates GAME_MASTER having grown ~400 more badges since the snapshot was
taken, inserted alphabetically among the vendored ones rather than
appended after them. This is a narrower, more defensible use of a stale
source than a live fetch would be: the snapshot only needs to supply text
that doesn't change once a badge exists, not track which badges currently
exist or their live rank targets (those still come from GAME_MASTER).
See `docs/ingestion-runbook.md`'s "Known pitfalls" section for the
operational risk this alignment carries if it ever degrades.
