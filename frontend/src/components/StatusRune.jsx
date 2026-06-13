import { describeStatus } from "../lib/status.js";

// A small glowing "rune" that renders a backend status with a themed tone.
// Pass `label` to override the derived label (e.g. to prefix with a field name).
export default function StatusRune({ value, label, title }) {
  const { label: derived, tone } = describeStatus(value);

  return (
    <span className={`status-pill tone-${tone}`} title={title ?? String(value ?? "")}>
      <span className="status-pill-dot" aria-hidden="true" />
      {label ?? derived}
    </span>
  );
}
