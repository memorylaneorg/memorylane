import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { BarChart3, CalendarDays, Camera, ChevronDown, FolderOpen, History, Images, LibraryBig, LogOut, MapPinned, Search, Settings as SettingsIcon, Star, Tags, Trash2, UserRound, Users, type LucideIcon } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { usePluginActive } from "../utils/plugins";
import CoreUpdateBanner from "./CoreUpdateBanner";
import { useTranslation } from "react-i18next";

// Mirrors life-archive-app's ArchiveNav.tsx: sticky glass header, serif
// wordmark, pill-shaped nav with icon + label links, active item filled
// solid (bg-photo-shell), icon-only circular search button at the end.
interface NavItem { to: string; labelKey: string; icon: LucideIcon; end?: boolean }
const browseItem: NavItem = { to: "/", labelKey: "navigation.browse", icon: FolderOpen, end: true };
const timelineItem: NavItem = { to: "/timeline", labelKey: "navigation.timeline", icon: CalendarDays };
const momentsItem: NavItem = { to: "/moments", labelKey: "navigation.moments", icon: Images };
const peopleItem: NavItem = { to: "/people", labelKey: "navigation.people", icon: Users };

// Every other plugin-backed page stays tucked in the Library dropdown
// regardless of plugin state (Locations etc. work with or without their
// plugin, just with reduced content) - People is different because without
// the People plugin the page is entirely empty, so it's promoted to a real
// top-level tab only once the plugin is actually active, and left out of
// the Library dropdown entirely rather than appearing in both places.
const libraryItems: NavItem[] = [
  { to: "/locations", labelKey: "navigation.locations", icon: MapPinned },
  { to: "/tags", labelKey: "navigation.tags", icon: Tags },
  { to: "/reports", labelKey: "navigation.reports", icon: BarChart3 },
  { to: "/gear-museum", labelKey: "navigation.gearMuseum", icon: Camera },
  { to: "/gear-timeline", labelKey: "navigation.gearTimeline", icon: History },
  { to: "/cleanup", labelKey: "navigation.cleanup", icon: Trash2 },
];

export default function Layout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const peopleAvailable = usePluginActive("com.memorylane.people");
  const libraryRef = useRef<HTMLDivElement>(null);
  const libraryButtonRef = useRef<HTMLButtonElement>(null);
  const userRef = useRef<HTMLDivElement>(null);
  const userButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { setLibraryOpen(false); setUserOpen(false); }, [location.pathname]);
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (document.querySelector("[data-media-viewer]")) return;
      const destinations: Record<string, string> = { "1": "/", "2": "/timeline", "3": "/moments", "4": "/favorites", "6": "/settings", "/": "/search" };
      if (event.key === "5") {
        event.preventDefault();
        setLibraryOpen(true);
        requestAnimationFrame(() => libraryButtonRef.current?.focus());
        return;
      }
      const destination = destinations[event.key];
      if (!destination) return;
      event.preventDefault();
      navigate(destination);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [navigate]);
  useEffect(() => {
    if (!libraryOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!libraryRef.current?.contains(event.target as Node)) setLibraryOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setLibraryOpen(false); libraryButtonRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [libraryOpen]);
  useEffect(() => {
    if (!userOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!userRef.current?.contains(event.target as Node)) setUserOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setUserOpen(false); userButtonRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [userOpen]);

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  const isSearchActive = location.pathname === "/search";
  const libraryActive = location.pathname === "/settings" || libraryItems.some((item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`));

  return (
    <div className="min-h-screen bg-page text-ink">
      <header className="sticky top-0 z-40 border-b border-border bg-nav-glass px-3 backdrop-blur-xl sm:px-5 lg:px-8">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-2">
          <Link className="flex shrink-0 items-center gap-2 font-serif text-lg font-semibold tracking-[-0.03em] text-ink sm:text-2xl" to="/">
            <img src="/icon-32.png" alt="" className="size-6 shrink-0 sm:size-7" />
            <span>MemoryLane</span>
          </Link>
          <nav className="flex items-center gap-1 rounded-full border border-border bg-nav-pill p-1 text-[13px] font-medium text-nav-muted shadow-nav">
            {[browseItem, timelineItem, momentsItem, { to: "/favorites", labelKey: "navigation.favorites", icon: Star } as NavItem, ...(peopleAvailable ? [peopleItem] : [])].map((item, index) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  title={index < 4 ? `${t(item.labelKey)} (${index + 1})` : t(item.labelKey)}
                  // Icon-only below sm (a full "Browse / Favorites / People /
                  // Settings" text row plus search/logout doesn't fit a
                  // phone-width screen at all - it was forcing the whole page
                  // to scroll horizontally) - text labels return once there's
                  // room. Browse alone stays visible on mobile; everything
                  // else in this group falls back to the Library dropdown's
                  // own sm:hidden links below.
                  className={({ isActive }) =>
                    `${item.to === "/" || item.to === "/timeline" ? "flex" : "hidden sm:flex"} size-9 items-center justify-center gap-2 rounded-full transition sm:w-auto sm:justify-start sm:px-3.5 ${
                      isActive || (item.to === "/favorites" && location.pathname.startsWith("/collections")) ? "bg-photo-shell text-white" : "hover:bg-hover-soft hover:text-ink"
                    }`
                  }
                >
                  <Icon aria-hidden size={15} strokeWidth={1.8} />
                  <span className="hidden sm:inline">{t(item.labelKey)}</span>
                </NavLink>
              );
            })}
            <div ref={libraryRef} className="relative">
              <button ref={libraryButtonRef} type="button" aria-label={t("navigation.library")} title={`${t("navigation.library")} (5)`} aria-expanded={libraryOpen}
                aria-controls="library-menu" onClick={() => { setLibraryOpen((open) => !open); setUserOpen(false); }}
                className={`flex size-9 items-center justify-center gap-2 rounded-full transition sm:w-auto sm:px-3.5 ${libraryActive || libraryOpen ? "bg-photo-shell text-white" : "hover:bg-hover-soft hover:text-ink"}`}>
                <LibraryBig aria-hidden size={15} strokeWidth={1.8} />
                <span className="hidden sm:inline">{t("navigation.library")}</span>
                <ChevronDown aria-hidden size={13} className="hidden sm:inline" />
              </button>
              {libraryOpen && <div id="library-menu" className="absolute right-0 top-full z-30 mt-2 w-52 rounded-xl border border-border bg-surface p-1.5 text-ink shadow-card"
                aria-label={t("navigation.libraryPages")}>
                {libraryItems.map((item) => {
                  const Icon = item.icon;
                  return <NavLink key={item.to} to={item.to} onClick={() => setLibraryOpen(false)}
                    className={({ isActive }) => `flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${isActive ? "bg-accent/15 text-accent" : "hover:bg-hover"}`}>
                    <Icon aria-hidden size={16} strokeWidth={1.8} />{t(item.labelKey)}
                  </NavLink>;
                })}
                <div className="my-1 border-t border-border" />
                <NavLink to="/settings" onClick={() => setLibraryOpen(false)} title={`${t("navigation.settings")} (6)`}
                  className={({ isActive }) => `flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${isActive ? "bg-accent/15 text-accent" : "hover:bg-hover"}`}>
                  <SettingsIcon aria-hidden size={16} strokeWidth={1.8} />{t("navigation.settings")}
                </NavLink>
                <div className="my-1 border-t border-border sm:hidden" />
                <NavLink to="/favorites" onClick={() => setLibraryOpen(false)}
                  className={({ isActive }) => `flex items-center gap-2 rounded-lg px-3 py-2 text-sm sm:hidden ${isActive ? "bg-accent/15 text-accent" : "hover:bg-hover"}`}>
                  <Star aria-hidden size={16} />{t("navigation.favorites")}
                </NavLink>
                {peopleAvailable && <NavLink to="/people" onClick={() => setLibraryOpen(false)}
                  className={({ isActive }) => `flex items-center gap-2 rounded-lg px-3 py-2 text-sm sm:hidden ${isActive ? "bg-accent/15 text-accent" : "hover:bg-hover"}`}>
                  <Users aria-hidden size={16} />{t("navigation.people")}
                </NavLink>}
              </div>}
            </div>
            <Link
              to="/search"
              aria-label={t("navigation.search")}
              title={`${t("navigation.search")} (/)`}
              className={`grid size-9 place-items-center rounded-full transition ${
                isSearchActive ? "bg-photo-shell text-white" : "hover:bg-hover-soft hover:text-ink"
              }`}
            >
              <Search aria-hidden size={16} strokeWidth={1.8} />
            </Link>
            {user && <div ref={userRef} className="relative">
              <button ref={userButtonRef} type="button" aria-label={user.username} title={user.username} aria-expanded={userOpen} aria-controls="user-menu"
                onClick={() => { setUserOpen((open) => !open); setLibraryOpen(false); }}
                className={`grid size-9 place-items-center rounded-full transition ${userOpen ? "bg-photo-shell text-white" : "text-nav-muted hover:bg-hover-soft hover:text-ink"}`}>
                <UserRound aria-hidden size={17} strokeWidth={1.8} />
              </button>
              {userOpen && <div id="user-menu" className="absolute right-0 top-full z-30 mt-2 w-52 rounded-xl border border-border bg-surface p-1.5 text-ink shadow-card">
                <div className="truncate px-3 py-2 text-sm font-medium" title={user.username}>{user.username}</div>
                <div className="my-1 border-t border-border" />
                <button type="button" onClick={() => void handleLogout()} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-hover">
                  <LogOut aria-hidden size={16} strokeWidth={1.8} />{t("navigation.logout")}
                </button>
              </div>}
            </div>}
          </nav>
        </div>
      </header>
      <CoreUpdateBanner />
      <main className="mx-auto w-full max-w-[1440px] px-3 py-6 sm:px-5 sm:py-8 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}
