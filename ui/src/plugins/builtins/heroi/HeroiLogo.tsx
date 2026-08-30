/**
 * heroi_aide brand mark (paths mirrored from danielss-dev/heroi_aide
 * `HeroiLogo.tsx`). Fill follows `currentColor` so the title bar and empty
 * state can share one asset.
 */
interface Props {
  size?: number;
  className?: string;
  title?: string;
}

export function HeroiLogo({ size = 16, className, title = 'heroi' }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      fill="currentColor"
      role={title ? 'img' : 'presentation'}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      className={className}
    >
      <path d="m8.9 29.4v-26.8c0-0.9 0.4-1.5 1.3-0.9l16.6 9.5c1.7 0.9 2.9 2.6 2.9 5.4v22.2c0 1.5-0.5 3.1-1.9 4.3l-18 15.5c-0.5 0.6-0.9 0.2-0.9-0.4v-28.8z" />
      <path d="m91.2 70.6v-20.3c0-0.6-0.4-0.9-0.8-0.4l-18.4 15.5c-1.2 1.2-1.8 2.6-1.8 4.3v12.7c0.1 3 0.6 4.5 3 5.9l17 10.1c0.6 0.4 1 0 0.9-0.8l0.1-27z" />
      <path d="m91.1 2.7c0-1-0.4-1.6-1.2-1l-16.9 9.7c-1.6 1-2.8 2.6-2.8 5.6v17.6c0 0.3 0 0.6-0.3 0.9l-6.4 5.5c-0.9 0.8-2.1 1.3-3.7 1.4h-22c-1.4 0-3.1 0.7-4.3 1.8l-23.7 20.2c-0.5 0.5-0.9 1.1-0.9 2v31.3c0 0.9 0.3 1.2 1 0.7l17.4-10.4c1.8-1 2.4-2.8 2.4-5.1v-20.6c0-3.9 3.5-6.1 6.3-6.1h19.4c1.5 0 3.1-0.5 4.3-1.6l7.3-6.5c0.3-0.3 0.5-0.5 0.5-1 0-2.7 2-4.5 4.3-4.5s4.4 1.8 4.4 4c0 2.8-2.8 4.6-5.3 4.1-0.4 0-0.8 0.1-1.1 0.4l-8.3 7.1c-0.4 0.3-0.1 0.5 0.3 0.5h9.3c1.3 0 2.4-0.3 3.3-1.1l16-14c0.7-0.7 0.8-1.6 0.7-3v-37.9z" />
    </svg>
  );
}
