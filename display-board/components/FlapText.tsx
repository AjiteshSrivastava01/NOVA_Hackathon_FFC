/** Split-flap style text. Re-keying on `text` replays the flip whenever it changes. */
export function FlapText({ text, className = "" }: { text: string; className?: string }) {
  return (
    <span key={text} className={`flap ${className}`} aria-label={text}>
      {Array.from(text).map((ch, i) =>
        ch === " " ? (
          <span key={i} className="flap-space" aria-hidden />
        ) : (
          <span key={i} className="flap-char" style={{ "--i": i } as React.CSSProperties} aria-hidden>
            {ch}
          </span>
        ),
      )}
    </span>
  );
}
