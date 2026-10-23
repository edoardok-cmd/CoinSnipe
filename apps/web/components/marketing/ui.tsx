import Image from 'next/image';
import { useId } from 'react';
import type { ReactNode, SVGProps } from 'react';
import { COIN_LOGOS } from '../../content/marketing';
import type { CoinSymbol, Temperature } from '../../content/marketing';

/* Shared marketing primitives: icons, coin logo, temperature pill, price change, sparkline. */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function svgProps(size: number, props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
    ...props,
  };
}

export function ArrowRight({ size = 16, ...p }: IconProps) {
  return (
    <svg {...svgProps(size, { strokeWidth: 2, ...p })}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function CheckIcon({ size = 18, ...p }: IconProps) {
  return (
    <svg {...svgProps(size, { strokeWidth: 2.2, stroke: '#3DF5B4', ...p })}>
      <path d="M5 12.5l4.2 4.2L19 7" />
    </svg>
  );
}

export function StarIcon({ size = 19, ...p }: IconProps) {
  return (
    <svg {...svgProps(size, p)}>
      <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />
    </svg>
  );
}

export function MenuIcon({ size = 20, ...p }: IconProps) {
  return (
    <svg {...svgProps(size, { strokeWidth: 2, ...p })}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function CloseIcon({ size = 20, ...p }: IconProps) {
  return (
    <svg {...svgProps(size, { strokeWidth: 2, ...p })}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function PlusIcon({ size = 20, ...p }: IconProps) {
  return (
    <svg {...svgProps(size, { strokeWidth: 2, ...p })}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function LockIcon({ size = 16, ...p }: IconProps) {
  return (
    <svg {...svgProps(size, p)}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </svg>
  );
}

export function BellIcon({ size = 16, ...p }: IconProps) {
  return (
    <svg {...svgProps(size, p)}>
      <path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z" />
      <path d="M10 20a2 2 0 004 0" />
    </svg>
  );
}

/** The four tab and feature icons, keyed by id. */
export const TabIcons = {
  coins: (p: IconProps) => (
    <svg {...svgProps(p.size ?? 20, p)}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
    </svg>
  ),
  niches: (p: IconProps) => (
    <svg {...svgProps(p.size ?? 20, p)}>
      <path d="M12 3c1 3 5 5 5 10a5 5 0 01-10 0c0-2.5 1.5-4 2.5-5 0 2 1 3 2 3 0-3-1-5.5.5-8z" />
    </svg>
  ),
  gems: (p: IconProps) => (
    <svg {...svgProps(p.size ?? 20, p)}>
      <path d="M6 4h12l3 5-9 11L3 9z" />
      <path d="M3 9h18" />
    </svg>
  ),
  portfolio: (p: IconProps) => (
    <svg {...svgProps(p.size ?? 20, p)}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2" />
      <path d="M3 13h18" />
    </svg>
  ),
} as const;

export const FeatureIcons = {
  gems: (p: IconProps) => (
    <svg {...svgProps(p.size ?? 26, { stroke: '#3DF5B4', ...p })}>
      <path d="M6 4h12l3 5-9 11L3 9z" />
      <path d="M3 9h18M9 9l3 11 3-11M9 9l-3-5M15 9l3-5" />
    </svg>
  ),
  signals: (p: IconProps) => (
    <svg {...svgProps(p.size ?? 26, { stroke: '#3DF5B4', ...p })}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" />
    </svg>
  ),
  track: (p: IconProps) => (
    <svg {...svgProps(p.size ?? 26, { stroke: '#3DF5B4', ...p })}>
      <path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z" />
      <path d="M10 20a2 2 0 004 0" />
    </svg>
  ),
  learn: (p: IconProps) => (
    <svg {...svgProps(p.size ?? 26, { stroke: '#3DF5B4', ...p })}>
      <path d="M3 8l9-4 9 4-9 4z" />
      <path d="M7 10.5V15c0 1.5 2.2 3 5 3s5-1.5 5-3v-4.5" />
    </svg>
  ),
} as const;

/** Logo of the CoinSnipe mark, from the brand asset. */
export function Logogram({ size = 26 }: { size?: number }) {
  return <Image src="/brand/logogram.svg" alt="" width={size} height={size} priority={false} />;
}

/** Real coin logo (square-ish, never cropped to a circle). Falls back to a labelled tile. */
export function CoinLogo({
  symbol,
  name,
  size = 34,
}: {
  symbol: CoinSymbol | null;
  name: string;
  size?: number;
}) {
  if (!symbol) {
    return (
      <span
        className="cicon"
        style={{ width: size, height: size }}
        role="img"
        aria-label={`${name} logo placeholder`}
      >
        {name.slice(0, 4).toUpperCase()}
      </span>
    );
  }
  return (
    <Image
      className="cimg"
      src={COIN_LOGOS[symbol]}
      alt=""
      width={size}
      height={size}
      sizes={`${size}px`}
    />
  );
}

/** Temperature pill: the bar is one white fill on a translucent track; the word carries the level. */
export function TemperaturePill({
  value,
  fill,
  wide = false,
}: {
  value: Temperature;
  fill: number;
  wide?: boolean;
}) {
  const cls = value === 'Heated' ? 'heated' : value === 'Cooled off' ? 'cooled' : '';
  return (
    <span className={`sig ${cls}${wide ? ' sig-wide' : ''}`}>
      <span
        className="gauge"
        role="img"
        aria-label={`Temperature level ${fill} out of 100`}
        style={{ ['--fill' as string]: fill }}
      >
        <i />
      </span>
      {value}
    </span>
  );
}

/** 24h / 7d price move. Up and down colours mark price moves only. */
export function Change({ value }: { value: number }) {
  const up = value >= 0;
  const text = `${Math.abs(value).toFixed(1)}%`;
  return (
    <span className={`chg ${up ? 'up' : 'down'}`}>
      <span aria-hidden="true">{up ? '▲' : '▼'}&nbsp;</span>
      <span className="sr-only">{up ? 'Up ' : 'Down '}</span>
      {text}
    </span>
  );
}

/** Seven-day line. Values are y positions: smaller means higher on screen. */
export function Sparkline({
  values,
  up,
  width = 130,
  height = 34,
  area = false,
  strokeWidth,
  className,
}: {
  values: number[];
  up: boolean;
  width?: number;
  height?: number;
  area?: boolean;
  strokeWidth?: number;
  className?: string;
}) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = Math.max(2, height * 0.08);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = pad + ((v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const d = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ');
  const color = up ? '#5ED3A0' : '#F08C78';
  const gid = `spark-${useId().replace(/:/g, '')}`;
  return (
    <svg
      className={`spark${className ? ` ${className}` : ''}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="none"
    >
      {area ? (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.28" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d={`${d} L${width} ${height} L0 ${height} Z`}
            style={{ fill: `url(#${gid})` }}
            stroke="none"
          />
        </>
      ) : null}
      <path d={d} stroke={color} strokeWidth={strokeWidth ?? 1.6} />
    </svg>
  );
}

export function Section({
  id,
  children,
  className = 'sec',
  labelledBy,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  return (
    <section id={id} className={className} aria-labelledby={labelledBy}>
      {children}
    </section>
  );
}
