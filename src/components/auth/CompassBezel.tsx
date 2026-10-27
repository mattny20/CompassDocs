// The default sign-in art's dial (1.16.0): rings and ticks drawn in white
// strokes over the accent field, anchored top-right on every aspect ratio
// (xMaxYMin slice) and masked off the text zones in CSS (.auth-art-bezel).
// Abstract on purpose, so it suits a white-labelled workspace. Server-safe;
// no request.

export function CompassBezel({ className = "" }: { className?: string }) {
  const c = { cx: 1380, cy: 220 };
  return (
    <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMaxYMin slice" fill="none" aria-hidden focusable="false" className={className}>
      <g stroke="currentColor">
        {[180, 320, 460, 600].map((r) => (
          <circle key={r} {...c} r={r} strokeWidth="1" vectorEffect="non-scaling-stroke" opacity=".1" />
        ))}
        <circle {...c} r="800" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity=".14" />
        <g transform="rotate(-90 1380 220)">
          {/* Ticks as dashed circles: the stroke width is the tick's length, pathLength is in degrees. */}
          <circle {...c} r="713" strokeWidth="26" pathLength="360" strokeDasharray="0.15 2.85" strokeDashoffset="0.075" opacity=".16" />
          <circle {...c} r="724" strokeWidth="48" pathLength="360" strokeDasharray="0.25 14.75" strokeDashoffset="0.125" opacity=".26" />
          <circle {...c} r="736" strokeWidth="72" pathLength="360" strokeDasharray="0.35 89.65" strokeDashoffset="0.175" opacity=".4" />
        </g>
      </g>
    </svg>
  );
}
