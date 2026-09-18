/**
 * The Arnifi lockup: sparkle, wordmark, and the two-tone call glyph.
 *
 * The paths are the same ones the Android caller card draws, so the two surfaces
 * a person sees during one request — this page and the phone — carry an identical
 * mark. Replace both together if the brand files are ever exported from source.
 */
export function ArnifiMark() {
  return (
    <div className="brand" aria-label="Arnifi">
      <span className="brand-wordmark">
        <svg className="brand-star" viewBox="0 0 24 24" role="img" aria-hidden="true">
          <path d="M12 .5c.35 6.05 5.45 11.15 11.5 11.5-6.05.35-11.15 5.45-11.5 11.5-.35-6.05-5.45-11.15-11.5-11.5C6.55 11.65 11.65 6.55 12 .5Z" />
        </svg>
        <span>Arnifi</span>
      </span>
      <svg className="brand-call" viewBox="0 0 24 24" role="img" aria-hidden="true">
        <path
          className="brand-call-dim"
          d="M4.66 2.02A2.66 2.66 0 0 0 2 4.68V6.2c0 3.16.97 6.25 2.78 8.84l1.14 1.62c.38.54 1.14.62 1.62.17l1.74-1.63c.74-.7.88-1.83.32-2.68l-.9-1.38a1.2 1.2 0 0 1-.08-1.61l1.62-3.07c.38-.73.23-1.62-.37-2.18L8.39 2.89a2.3 2.3 0 0 0-1.83-.72Z"
        />
        <path d="M15.16 13.84a2.3 2.3 0 0 1 2.16-.47l3.31 1.14c.82.28 1.37 1.05 1.37 1.92v2.89a2.66 2.66 0 0 1-2.66 2.66h-.74a15.2 15.2 0 0 1-9.04-2.99l-1.54-1.14a1.1 1.1 0 0 1-.15-1.6l1.56-1.66a2.06 2.06 0 0 1 2.63-.38l1.38.8c.51.3 1.16.23 1.59-.17Z" />
      </svg>
    </div>
  );
}
