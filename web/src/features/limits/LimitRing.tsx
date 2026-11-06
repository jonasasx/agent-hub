/** The ring of a collapsed subscription (docs/prototypes/tool-windows.html .sd): the share of the worst window, the colour is the level. */
const R = 5.5;
const LEN = 2 * Math.PI * R;

export type RingTone = 'ok' | 'warn' | 'bad';

export function LimitRing({ pct, tone, tip }: { pct: number; tone: RingTone; tip: string }) {
  const share = Math.max(0, Math.min(100, pct));
  return (
    <svg className={`tw-ring ${tone}`} viewBox="0 0 16 16" width="15" height="15" role="img" aria-label={tip}>
      <title>{tip}</title>
      <circle className="tr" cx="8" cy="8" r={R} />
      <circle className="vl" cx="8" cy="8" r={R} strokeDasharray={`${((LEN * share) / 100).toFixed(2)} ${LEN.toFixed(2)}`} transform="rotate(-90 8 8)" />
    </svg>
  );
}
