/**
 * A small "i" info icon that reveals a plain-language explanation on hover or
 * keyboard focus. Pure CSS tooltip (no JS), so it works in server components and
 * is accessible via `tabIndex` + `aria-label`.
 */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="infotip" tabIndex={0} role="note" aria-label={text}>
      <span className="infotip-icon" aria-hidden="true">
        i
      </span>
      <span className="infotip-bubble">{text}</span>
    </span>
  );
}
