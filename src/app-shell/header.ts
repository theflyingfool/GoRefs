import type { Repository } from "../data/repository";
import { clear, el } from "../ui/dom";

export type HeaderMode =
  | { kind: "filter"; value: string; onChange: (value: string) => void; filterButton?: { activeCount: number; onClick: () => void } }
  | { kind: "jump"; repo: Repository; onSelect: (speciesSlug: string) => void }
  | { kind: "none"; title?: string };

// Nav moved to the bottom tab bar / sidebar (nav-drawer.ts) — this header is
// just search (+ an optional filter-sheet trigger) now, no hamburger. "none"
// mode still shows a plain screen title (mockup's topbar) so pages that
// aren't the grid/detail aren't left with a blank header bar.
export function renderHeader(container: HTMLElement, mode: HeaderMode, currentTrainerName: string) {
  clear(container);

  const trainerBadge = el("span", { class: "header-trainer-badge" }, [currentTrainerName]);

  if (mode.kind === "none") {
    if (mode.title) container.append(el("div", { class: "app-header-title" }, [mode.title]));
    container.append(trainerBadge);
    return;
  }

  const searchWrap = el("div", { class: "header-search" });

  if (mode.kind === "filter") {
    const input = el("input", {
      type: "search",
      placeholder: "Filter by name or #",
      value: mode.value,
      class: "search-input",
    }) as HTMLInputElement;
    // Debounced: this fires a full grid re-render + SQL query per keystroke
    // otherwise, which is unnecessary re-render churn on every character typed.
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => mode.onChange(input.value), 150);
    });
    searchWrap.append(input);

    if (mode.filterButton) {
      const { activeCount, onClick } = mode.filterButton;
      const filterBtn = el(
        "button",
        { type: "button", class: "filter-icon-button", "aria-haspopup": "true", "aria-label": "Filters", "aria-expanded": "false" },
        [
          "▤",
          activeCount > 0 ? el("span", { class: "filter-icon-badge" }, [String(activeCount)]) : "",
        ],
      );
      filterBtn.addEventListener("click", onClick);
      searchWrap.append(filterBtn);
    }
  } else if (mode.kind === "jump") {
    const input = el("input", {
      type: "search",
      placeholder: "Jump to a Pokémon…",
      class: "search-input",
    }) as HTMLInputElement;
    const results = el("ul", { class: "jump-results" });

    input.addEventListener("input", () => {
      clear(results);
      const matches = mode.repo.searchSpecies(input.value);
      for (const species of matches) {
        const button = el("button", { type: "button", class: "jump-result" }, [
          el("span", { class: "dex-num" }, [`#${species.dexNumber}`]),
          ` ${species.name}`,
        ]);
        button.addEventListener("click", () => {
          input.value = "";
          clear(results);
          mode.onSelect(species.slug);
        });
        results.append(el("li", {}, [button]));
      }
    });

    searchWrap.append(input, results);
  }

  container.append(searchWrap, trainerBadge);
}

// Grid interactions (chip toggles, etc.) call this after every filter change
// instead of re-invoking renderHeader — a full header rerender would also
// tear down/rebuild the search input (losing focus/debounce state) just to
// update a badge number.
export function updateFilterBadge(container: HTMLElement, count: number) {
  const button = container.querySelector<HTMLElement>(".filter-icon-button");
  if (!button) return;
  let badge = button.querySelector<HTMLElement>(".filter-icon-badge");
  if (count > 0) {
    if (!badge) {
      badge = el("span", { class: "filter-icon-badge" });
      button.append(badge);
    }
    badge.textContent = String(count);
  } else {
    badge?.remove();
  }
}
