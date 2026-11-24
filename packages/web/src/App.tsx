import { useEffect } from "react";
import { subscribe } from "./api";
import { COMMANDS, findCommand, SEQUENCE_PREFIXES } from "./commands";
import { comboOf, isTypingTarget, Sequencer } from "./keys";
import { boot, closeGoals, getState, goInbox, handleEvent, navigate, setState, useApp } from "./state";
import { cancelAvailability, closeWeek } from "./cal";
import { DayPane, EventPopover, WeekPage } from "./components/Calendar";
import { Composer } from "./components/Composer";
import { EventForm } from "./components/EventForm";
import { GoalsPage } from "./components/Goals";
import { Overlay } from "./components/Overlays";
import { AskPanel, ContactPanel, Onboarding, Toasts, TopBar } from "./components/Panels";
import { ResearchCards, ResearchPanel } from "./components/Research";
import { closeResearch } from "./research";
import { Sidebar } from "./components/Sidebar";
import { SettingsPanel } from "./components/Settings";
import { ThreadList } from "./components/ThreadList";
import { ThreadView } from "./components/ThreadView";

function useKeyboard() {
  useEffect(() => {
    const seq = new Sequencer(SEQUENCE_PREFIXES);
    const onKey = (e: KeyboardEvent) => {
      const combo = comboOf(e);
      if (!combo) return;
      const s = getState();
      if (s.overlay) {
        if (combo === "esc") setState({ overlay: null });
        return;
      }
      if (s.calForm) return; // the event editor handles its own keys
      if (s.calPopover && combo === "esc") return setState({ calPopover: null });
      if (isTypingTarget(e.target)) {
        if (combo === "mod+k" || combo === "mod+shift+k") {
          e.preventDefault();
          setState({ overlay: { kind: "palette" } });
        }
        return;
      }
      if (combo === "esc") {
        if (s.searchOpen) return setState({ searchOpen: false });
        if (s.askOpen) return setState({ askOpen: false });
        if (s.research) return closeResearch();
        if (s.navPeek) return setState({ navPeek: false });
        if (s.calAvail) return cancelAvailability();
        if (s.goalsOpen) return closeGoals();
        if (s.calPane === "week") return closeWeek();
        if (s.selected.length) return setState({ selected: [] });
        if (s.compose && !s.openId) return setState({ compose: null });
        if (!s.openId && s.route.view === "search") return document.dispatchEvent(new CustomEvent("iris-command", { detail: "goInbox" }));
      }
      // ⌃1 / ⌃2 …: that account's Inbox (account switch as a scope inside one window)
      const acct = combo.match(/^ctrl\+([1-9])$/);
      if (acct) {
        const a = s.status?.accounts[Number(acct[1]) - 1];
        if (a) {
          e.preventDefault();
          void goInbox(a.id);
        }
        return;
      }
      const full = seq.feed(combo);
      if (!full) {
        e.preventDefault();
        return;
      }
      const cmd = findCommand(full, s);
      if (cmd) {
        e.preventDefault();
        void cmd.run();
      }
    };
    const onCommand = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      void COMMANDS.find((c) => c.id === id)?.run();
    };
    // Input modality: surfaces opened from the keyboard appear instantly
    // (styles.css zeroes --dur-popover/--dur-modal/--dur-drawer under html[data-input="keyboard"]).
    // Capture phase, so components that stop propagation (composer, pickers) still flip the flag.
    const root = document.documentElement;
    const viaKeyboard = (e: KeyboardEvent) => {
      if (!["Shift", "Meta", "Control", "Alt", "CapsLock"].includes(e.key)) root.dataset.input = "keyboard";
    };
    const viaPointer = () => {
      root.dataset.input = "pointer";
    };
    window.addEventListener("keydown", viaKeyboard, true);
    window.addEventListener("pointerdown", viaPointer, true);
    window.addEventListener("keydown", onKey);
    document.addEventListener("iris-command", onCommand);
    return () => {
      window.removeEventListener("keydown", viaKeyboard, true);
      window.removeEventListener("pointerdown", viaPointer, true);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("iris-command", onCommand);
    };
  }, []);
}

export function App() {
  const theme = useApp((s) => s.theme);
  const status = useApp((s) => s.status);
  const bootError = useApp((s) => s.bootError);
  const openId = useApp((s) => s.openId);
  const openAccount = useApp((s) => s.openAccount);
  const compose = useApp((s) => s.compose);
  const overlay = useApp((s) => s.overlay);
  const askOpen = useApp((s) => s.askOpen);
  const researchOpen = useApp((s) => !!s.research);
  const calPane = useApp((s) => s.calPane);
  const goalsOpen = useApp((s) => s.goalsOpen);
  const availMode = useApp((s) => !!s.calAvail);
  const navPinned = useApp((s) => s.navPinned);
  useKeyboard();

  useEffect(() => {
    void boot();
    return subscribe(handleEvent, (up) => {
      const was = getState().connected;
      setState({ connected: up });
      if (up && !was) void boot();
    });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  if (bootError)
    return (
      <div className="onboarding">
        <h1>Iris can't reach its daemon</h1>
        <p className="error">{bootError}</p>
        <p className="el">
          Start it with <code>iris start</code>, then reload.
        </p>
        <button className="primary" onClick={() => void boot()}>
          Retry
        </button>
      </div>
    );
  if (!status) return <div className="splash" />;
  if (!status.accounts.length)
    return (
      <>
        <Onboarding />
        <Toasts />
      </>
    );

  const docked = compose && (compose.popped || compose.threadId !== openId || (compose.threadAccount ?? compose.accountId) !== openAccount);
  return (
    <div className={`app${navPinned ? " nav-pinned" : ""}`}>
      <TopBar />
      <div className={`main${askOpen ? " with-ask" : ""}${researchOpen ? " with-research" : ""}`}>
        <Sidebar />
        <div className="center">
          {goalsOpen ? <GoalsPage /> : calPane === "week" && <WeekPage />}
          {/* kept mounted under the week page so an inline draft (and its caret) survives Share Availability */}
          <div className="center-view" hidden={calPane === "week" || goalsOpen}>
            {openId ? <ThreadView /> : <ThreadList />}
          </div>
        </div>
        {calPane === "day" ? <DayPane /> : calPane === "week" ? null : <ContactPanel />}
        <AskPanel />
        <ResearchPanel />
      </div>
      {docked && (
        <div className="compose-dock" hidden={availMode}>
          <Composer compose={compose} />
        </div>
      )}
      <EventPopover />
      <EventForm />
      <Overlay />
      {overlay?.kind === "settings" && <SettingsPanel section={overlay.section} />}
      <ResearchCards />
      <Toasts />
    </div>
  );
}

export { navigate };
