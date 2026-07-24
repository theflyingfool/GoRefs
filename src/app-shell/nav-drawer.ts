import { clear, el } from "../ui/dom";
import type { Route } from "./router";
import { navigate } from "./router";

interface NavItem {
  label: string;
  path: string;
  routeName: Route["name"];
  icon: string;
  muted?: boolean;
  /** Gets its own slot in the phone tab bar / isn't folded into "More". */
  primary?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { label: "Pokedex", path: "/data-entry", routeName: "data-entry-grid", icon: "▣", primary: true },
  { label: "Collection", path: "/collection", routeName: "collection", icon: "🎒", primary: true },
  { label: "Log a Catch", path: "/log-catch", routeName: "log-catch", icon: "＋", primary: true },
  { label: "Stats", path: "/stats", routeName: "stats", icon: "📊", primary: true },
  { label: "Trainer", path: "/trainer", routeName: "trainer", icon: "🧢" },
  { label: "Tags", path: "/tags", routeName: "tags", icon: "🏷" },
  { label: "Settings", path: "/settings", routeName: "settings", icon: "⚙" },
  { label: "Search Tools", path: "/search-tools", routeName: "search-tools", icon: "🔍" },
  { label: "Coverage Report", path: "/coverage-report", routeName: "coverage-report", icon: "📋" },
  { label: "Help", path: "/help", routeName: "help", icon: "❓" },
  { label: "Achievements", path: "/achievements", routeName: "achievements", icon: "🏆", muted: true },
  { label: "XP Assistant", path: "/xp-assistant", routeName: "xp-assistant", icon: "⭐", muted: true },
];

const PRIMARY_ITEMS = NAV_ITEMS.filter((item) => item.primary);
const MORE_ITEMS = NAV_ITEMS.filter((item) => !item.primary);

function isItemCurrent(item: NavItem, currentRouteName: Route["name"]): boolean {
  return item.routeName === currentRouteName || (item.routeName === "data-entry-grid" && currentRouteName === "data-entry-detail");
}

function navButton(item: NavItem, isCurrent: boolean, onNavigate: () => void, extraClass = ""): HTMLElement {
  const button = el(
    "button",
    {
      type: "button",
      class: ["nav-item", extraClass, item.muted ? "nav-item-muted" : "", isCurrent ? "nav-item-current" : ""].filter(Boolean).join(" "),
    },
    [el("span", { class: "nav-item-icon" }, [item.icon]), el("span", { class: "nav-item-label" }, [item.label])],
  );
  button.addEventListener("click", () => {
    navigate(item.path);
    onNavigate();
  });
  return button;
}

/** Persistent left sidebar (>=720px) — every item gets a slot, nothing folded away since there's room. */
export function renderSidebar(container: HTMLElement, currentRouteName: Route["name"], onNavigate: () => void) {
  clear(container);
  const list = el("ul", { class: "nav-list sidebar-list" });
  for (const item of PRIMARY_ITEMS) {
    list.append(el("li", {}, [navButton(item, isItemCurrent(item, currentRouteName), onNavigate)]));
  }
  list.append(el("li", { class: "nav-sep" }));
  for (const item of MORE_ITEMS) {
    list.append(el("li", {}, [navButton(item, isItemCurrent(item, currentRouteName), onNavigate)]));
  }
  container.append(el("h2", { class: "nav-title" }, ["PoGo Buddy"]), list);
}

/** Bottom tab bar (<720px): the 4 primary items plus a "More" tab covering everything else. */
export function renderTabBar(container: HTMLElement, currentRouteName: Route["name"], onNavigate: () => void, onMoreClick: () => void) {
  clear(container);
  for (const item of PRIMARY_ITEMS) {
    const isCurrent = isItemCurrent(item, currentRouteName);
    container.append(navButton(item, isCurrent, onNavigate, "tab-item"));
  }
  const moreIsCurrent = MORE_ITEMS.some((item) => isItemCurrent(item, currentRouteName));
  const moreButton = el(
    "button",
    { type: "button", class: `nav-item tab-item${moreIsCurrent ? " nav-item-current" : ""}`, "aria-haspopup": "true" },
    [el("span", { class: "nav-item-icon" }, ["⋯"]), el("span", { class: "nav-item-label" }, ["More"])],
  );
  moreButton.addEventListener("click", () => onMoreClick());
  container.append(moreButton);
}

/** Contents of the phone-only "More" overlay flyout — just the folded-away items. */
export function renderMoreList(container: HTMLElement, currentRouteName: Route["name"], onNavigate: () => void) {
  clear(container);
  const list = el("ul", { class: "nav-list" });
  for (const item of MORE_ITEMS) {
    list.append(el("li", {}, [navButton(item, isItemCurrent(item, currentRouteName), onNavigate)]));
  }
  container.append(el("h2", { class: "nav-title" }, ["More"]), list);
}
