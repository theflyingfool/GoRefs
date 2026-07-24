import { renderBootFailureRescue } from "./app-shell/boot-failure-rescue";
import { renderHeader, updateFilterBadge } from "./app-shell/header";
import { renderMoreList, renderSidebar, renderTabBar } from "./app-shell/nav-drawer";
import { parseRoute, speciesDetailPath } from "./app-shell/router";
import { applyTheme, getThemePreference } from "./app-shell/theme";
import { mountWriteFailureBanner, reportWriteFailure } from "./app-shell/write-failure-banner";
import { createSqliteRepository } from "./data/sqlite-repository";
import type { Repository, GridFilterField } from "./data/repository";
import { renderFilterSheetContent, countActiveFilters, type GridState, type GridCallbacks } from "./features/data-entry/grid-types";
import SpeciesDetailPage from "./features/data-entry/SpeciesDetailPage.vue";
import DexGridPage from "./features/data-entry/DexGridPage.vue";
import CoverageReportPage from "./features/coverage-report/CoverageReportPage.vue";
import SettingsPage from "./features/settings/SettingsPage.vue";
import TrainerPage from "./features/trainer/TrainerPage.vue";
import CollectionPage from "./features/collection/CollectionPage.vue";
import EditInstancePage from "./features/collection/EditInstancePage.vue";
import LogCatchPage from "./features/log-catch/LogCatchPage.vue";
import StatsPage from "./features/stats/StatsPage.vue";
import { mountVueRoute, unmountCurrentVueRoute } from "./app-shell/mount-vue";
import HelpPage from "./features/help/HelpPage.vue";
import { renderAchievementsPage, renderSearchToolsPage, renderXpAssistantPage } from "./features/stubs";
import { createOverlayPanel, bindEscapeToClose } from "./ui/overlay-panel";
import { el } from "./ui/dom";

// Plain-title header content for every "none"-mode route (data-entry-grid/
// data-entry-detail build their own header via kind "filter"/"jump" instead;
// edit-instance also builds its own so its title can show the species name).
const ROUTE_TITLES: Partial<Record<import("./app-shell/router").Route["name"], string>> = {
  stats: "Stats",
  "search-tools": "Search Tools",
  "coverage-report": "Coverage Report",
  settings: "Settings",
  trainer: "Trainer",
  collection: "Collection",
  "log-catch": "Log a Catch",
  help: "Help",
  achievements: "Achievements",
  "xp-assistant": "XP Assistant",
};

const app = document.getElementById("app")!;
const loadingEl = el("p", { class: "app-loading" }, ["Loading your dex…"]);
app.append(loadingEl);
mountWriteFailureBanner(app);

createSqliteRepository(reportWriteFailure)
  .then((repo) => {
    loadingEl.remove();
    bootstrap(repo);
  })
  .catch((err) => {
    console.error("Failed to open the on-device database:", err);
    loadingEl.remove();
    renderBootFailureRescue(app, err);
  });

function bootstrap(repo: Repository) {
  applyTheme(getThemePreference(repo));

  // Sidebar (>=720px) and tab bar (<720px) are both always rendered — which
  // one is visible is pure CSS (@media), so there's no resize listener or
  // layout-mode JS branching needed. The "More" flyout only ever gets opened
  // from the tab bar (the sidebar shows every item, nothing to fold away).
  const sidebarEl = el("nav", { class: "sidebar-nav" });
  const headerEl = el("header", { class: "app-header" });
  const contentEl = el("main", { class: "app-content" });
  const mainWrap = el("div", { class: "app-main" }, [headerEl, contentEl]);
  const tabBarEl = el("nav", { class: "tab-bar" });
  const moreDrawerEl = el("nav", { class: "nav-drawer more-drawer", inert: "" });
  // "more-scrim" (in addition to nav-scrim) so the desktop sidebar CSS can
  // hide this one specifically without also hiding the filter sheet's
  // click-outside catcher, which is a plain .nav-scrim too and needs to
  // stay clickable (just invisible) at that width.
  const moreScrimEl = el("div", { class: "nav-scrim more-scrim" });
  // Filter sheet (grid) / anchored panel (>=720px) — same pattern as the
  // More flyout, lives outside contentEl so the grid's own clear()-and-rebuild
  // cycle on every filter interaction never touches it.
  const filterSheetEl = el("div", { class: "filter-sheet", inert: "" });
  const filterScrimEl = el("div", { class: "nav-scrim" });
  app.append(sidebarEl, mainWrap, tabBarEl, moreDrawerEl, moreScrimEl, filterSheetEl, filterScrimEl);

  const gridState: GridState = {
    filterText: "",
    caughtFilter: "all",
    collapsedRegions: new Set(),
    fieldFilters: {},
    moreFiltersOpen: false,
    selectMode: false,
    selectedSpecies: new Set(),
    bulkField: "registered",
    bulkValue: true,
    bulkGranularity: "species",
  };

  // Created once against stable containers — renderTabBar rebuilds the
  // button elements inside tabBarEl on every render(), so the trigger is
  // looked up fresh each time (see createOverlayPanel's getTrigger param)
  // rather than captured here.
  const morePanel = createOverlayPanel(moreDrawerEl, moreScrimEl, () => tabBarEl.querySelector<HTMLElement>(".tab-item[aria-haspopup]"));
  const filterPanel = createOverlayPanel(filterSheetEl, filterScrimEl, () => headerEl.querySelector<HTMLElement>(".filter-icon-button"));
  bindEscapeToClose(morePanel, filterPanel);

  function render() {
    const route = parseRoute(location.hash);

    // Every route render tears down a previous Vue mount first (see
    // mount-vue.ts) — vanilla render functions just clear(container) and
    // rebuild, which doesn't tell a mounted Vue app instance to unmount.
    unmountCurrentVueRoute();

    renderSidebar(sidebarEl, route.name, () => {});
    renderTabBar(tabBarEl, route.name, () => morePanel.close(), () => morePanel.open());
    renderMoreList(moreDrawerEl, route.name, () => morePanel.close());

    if (route.name === "data-entry-grid") {
      const renderGrid = () => {
        mountVueRoute(contentEl, DexGridPage, { repo, state: gridState, callbacks: gridCallbacks });
        renderFilterSheetContent(filterSheetEl, repo, gridState, gridCallbacks);
        updateFilterBadge(headerEl, countActiveFilters(gridState));
      };
      const gridCallbacks: GridCallbacks = {
        onSelectSpecies: (slug: string) => {
          location.hash = speciesDetailPath(slug);
        },
        onCaughtFilterChange: (value: GridState["caughtFilter"]) => {
          gridState.caughtFilter = value;
          renderGrid();
        },
        onToggleRegion: (regionSlug: string) => {
          if (gridState.collapsedRegions.has(regionSlug)) gridState.collapsedRegions.delete(regionSlug);
          else gridState.collapsedRegions.add(regionSlug);
          renderGrid();
        },
        onCycleFieldFilter: (field: GridFilterField) => {
          const current = gridState.fieldFilters[field];
          if (current === undefined) gridState.fieldFilters[field] = "include";
          else if (current === "include") gridState.fieldFilters[field] = "exclude";
          else delete gridState.fieldFilters[field];
          renderGrid();
        },
        onToggleMoreFilters: () => {
          gridState.moreFiltersOpen = !gridState.moreFiltersOpen;
          renderGrid();
        },
        onToggleSelectMode: () => {
          gridState.selectMode = !gridState.selectMode;
          if (!gridState.selectMode) {
            gridState.selectedSpecies.clear();
            gridState.bulkGranularity = "species";
          }
          renderGrid();
        },
        onGranularityChange: (granularity: GridState["bulkGranularity"]) => {
          gridState.bulkGranularity = granularity;
          renderGrid();
        },
        onBulkFieldChange: (field: GridState["bulkField"]) => {
          gridState.bulkField = field;
          renderGrid();
        },
        onBulkValueChange: (value: boolean) => {
          gridState.bulkValue = value;
          renderGrid();
        },
        onApplyBulk: () => {
          const slugs = [...gridState.selectedSpecies];
          if (slugs.length === 0) return;
          void repo.bulkSetSpeciesPersonalField(slugs, gridState.bulkField, gridState.bulkValue).then(() => {
            gridState.selectedSpecies.clear();
            renderGrid();
          });
        },
        onClearSelection: () => {
          gridState.selectedSpecies.clear();
          renderGrid();
        },
      };

      renderHeader(headerEl, {
        kind: "filter",
        value: gridState.filterText,
        onChange: (v) => {
          gridState.filterText = v;
          renderGrid();
        },
        filterButton: {
          activeCount: countActiveFilters(gridState),
          onClick: () => filterPanel.toggle(),
        },
      });
      renderGrid();
    } else if (route.name === "data-entry-detail") {
      renderHeader(headerEl, {
        kind: "jump",
        repo,
        onSelect: (slug) => {
          location.hash = speciesDetailPath(slug);
        },
      });
      mountVueRoute(contentEl, SpeciesDetailPage, {
        repo,
        speciesSlug: route.speciesSlug,
        onBack: () => {
          location.hash = "/data-entry";
        },
      });
    } else if (route.name === "edit-instance") {
      const loaded = repo.getPokemonInstance(route.instanceId);
      renderHeader(headerEl, { kind: "none", title: loaded ? `Edit ${loaded.species.name}` : "Edit specimen" });
      mountVueRoute(contentEl, EditInstancePage, { repo, instanceId: route.instanceId });
    } else {
      renderHeader(headerEl, { kind: "none", title: ROUTE_TITLES[route.name] });
      switch (route.name) {
        case "stats":
          mountVueRoute(contentEl, StatsPage, { repo });
          break;
        case "search-tools":
          renderSearchToolsPage(contentEl);
          break;
        case "coverage-report":
          mountVueRoute(contentEl, CoverageReportPage, {});
          break;
        case "settings":
          mountVueRoute(contentEl, SettingsPage, { repo });
          break;
        case "trainer":
          mountVueRoute(contentEl, TrainerPage, { repo });
          break;
        case "collection":
          mountVueRoute(contentEl, CollectionPage, { repo });
          break;
        case "log-catch":
          mountVueRoute(contentEl, LogCatchPage, { repo, prefillSpeciesSlug: route.prefillSpeciesSlug });
          break;
        case "help":
          mountVueRoute(contentEl, HelpPage, {});
          break;
        case "achievements":
          renderAchievementsPage(contentEl);
          break;
        case "xp-assistant":
          renderXpAssistantPage(contentEl);
          break;
      }
    }
  }

  window.addEventListener("hashchange", () => {
    morePanel.close();
    filterPanel.close();
    window.scrollTo(0, 0);
    render();
  });
  render();
}
