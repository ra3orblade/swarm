/**
 * Security (M14): three tabs over one subject.
 *
 * - **Activity** — what agents reached for (the M9.9 scan): hosts, installs, credential files, and
 *   what each rule family would catch.
 * - **Stack** — what each project runs, read from its lockfiles (M14.1).
 * - **Advisories** — known advisories on those exact versions, once enabled (M14.4).
 *
 * The chips are the same pattern Graphs uses; only the open tab fetches anything.
 */
import { Section } from "../components/ui";
import { useUiStore } from "../state/ui";
import { Activity } from "./security/Activity";
import { StackTab } from "./security/Stack";

type Tab = "activity" | "stack";

const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ["activity", "Activity"],
  ["stack", "Stack"],
];

const HINTS: Record<Tab, string> = {
  activity: "what agents reached for · last 14 days",
  stack: "what each project runs, from its lockfiles",
};

export function Security() {
  const raw = useUiStore((s) => s.securityTab);
  const setTab = useUiStore((s) => s.setSecurityTab);
  const tab: Tab = raw === "stack" ? "stack" : "activity";

  return (
    <>
      <Section title="Security" hint={HINTS[tab]} />
      <div className="chips">
        {TABS.map(([key, label]) => (
          <button
            type="button"
            key={key}
            className={tab === key ? "chip on" : "chip"}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "activity" && <Activity />}
      {tab === "stack" && <StackTab />}
    </>
  );
}
