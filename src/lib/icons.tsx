// Liquid Num icon set — Lucide-style 24-grid stroke icons, inline so the app
// stays dependency-free. All icons inherit currentColor; pass size to scale.
import type { CSSProperties } from 'react';

export interface IconProps {
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}

function icon(children: JSX.Element, { size = 18, strokeWidth = 2, style }: IconProps = {}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: 'none', ...style }}
    >
      {children}
    </svg>
  );
}

export const MessageIcon = (p?: IconProps) =>
  icon(<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />, p);

export const RouteIcon = (p?: IconProps) =>
  icon(
    <>
      <circle cx="6" cy="19" r="3" />
      <circle cx="18" cy="5" r="3" />
      <path d="M12 19h4.5a3.5 3.5 0 0 0 0-7h-8a3.5 3.5 0 0 1 0-7H12" />
    </>,
    p,
  );

export const SparklesIcon = (p?: IconProps) =>
  icon(
    <>
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21" />
      <path d="M12 7.5 13.4 10.6 16.5 12 13.4 13.4 12 16.5 10.6 13.4 7.5 12 10.6 10.6Z" />
    </>,
    p,
  );

export const CalendarIcon = (p?: IconProps) =>
  icon(
    <>
      <rect x="3" y="4" width="18" height="17" rx="4" />
      <path d="M16 2v4M8 2v4M3 9.5h18" />
    </>,
    p,
  );

export const ShareIcon = (p?: IconProps) =>
  icon(
    <>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
    </>,
    p,
  );

export const StarIcon = (p?: IconProps) =>
  icon(<path d="M12 2.5 14.9 8.4 21.5 9.3 16.7 13.9 17.9 20.4 12 17.3 6.1 20.4 7.3 13.9 2.5 9.3 9.1 8.4Z" />, p);

export const MicIcon = (p?: IconProps) =>
  icon(
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3" />
    </>,
    p,
  );

export const SendIcon = (p?: IconProps) =>
  icon(<path d="M12 19V5M5 12l7-7 7 7" />, p);

export const UsersIcon = (p?: IconProps) =>
  icon(
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>,
    p,
  );

export const CheckIcon = (p?: IconProps) => icon(<path d="M20 6 9 17l-5-5" />, p);

export const XIcon = (p?: IconProps) => icon(<path d="M18 6 6 18M6 6l12 12" />, p);

export const ChevronDownIcon = (p?: IconProps) => icon(<path d="m6 9 6 6 6-6" />, p);
export const ChevronLeftIcon = (p?: IconProps) => icon(<path d="m15 18-6-6 6-6" />, p);
export const ChevronRightIcon = (p?: IconProps) => icon(<path d="m9 18 6-6-6-6" />, p);

export const PlaneIcon = (p?: IconProps) =>
  icon(<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2Z" />, p);

export const DiningIcon = (p?: IconProps) =>
  icon(
    <>
      <path d="M3 2v7a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V2" />
      <path d="M6 2v20" />
      <path d="M21 15V2a5 5 0 0 0-5 5v6a2 2 0 0 0 2 2h3Zm0 0v7" />
    </>,
    p,
  );

export const WavesIcon = (p?: IconProps) =>
  icon(
    <>
      <path d="M2 6c1.5 1.2 3 1.2 4.5 0S9.5 4.8 11 6s3 1.2 4.5 0 3-1.2 4.5 0" transform="translate(0 1)" />
      <path d="M2 12c1.5 1.2 3 1.2 4.5 0s3-1.2 4.5 0 3 1.2 4.5 0 3-1.2 4.5 0" />
      <path d="M2 17c1.5 1.2 3 1.2 4.5 0s3-1.2 4.5 0 3 1.2 4.5 0 3-1.2 4.5 0" />
    </>,
    p,
  );

export const MusicIcon = (p?: IconProps) =>
  icon(
    <>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </>,
    p,
  );

export const LeafIcon = (p?: IconProps) =>
  icon(
    <>
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z" />
      <path d="M2 21c0-3 1.9-5.4 5.1-6C9.5 14.5 12 13 13 12" />
    </>,
    p,
  );

export const LandmarkIcon = (p?: IconProps) =>
  icon(
    <>
      <path d="M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7" />
      <path d="M12 2 2 9h20Z" />
    </>,
    p,
  );

export const VideoIcon = (p?: IconProps) =>
  icon(
    <>
      <path d="m22 8-6 4 6 4V8Z" />
      <rect x="2" y="6" width="14" height="12" rx="3" />
    </>,
    p,
  );

export const WalletIcon = (p?: IconProps) =>
  icon(
    <>
      <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5" />
      <circle cx="16" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
    </>,
    p,
  );

export const CameraIcon = (p?: IconProps) =>
  icon(
    <>
      <path d="M14.5 4h-5L7.2 6.5H4a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8.5a2 2 0 0 0-2-2h-3.2L14.5 4Z" />
      <circle cx="12" cy="13" r="3.2" />
    </>,
    p,
  );

export const RainIcon = (p?: IconProps) =>
  icon(
    <>
      <path d="M17.5 16a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.7 1.6A4 4 0 0 0 6.5 16Z" />
      <path d="M8 19v2M12 18v2.5M16 19v2" />
    </>,
    p,
  );

export const CopyIcon = (p?: IconProps) =>
  icon(
    <>
      <rect x="9" y="9" width="12" height="12" rx="2.5" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>,
    p,
  );

export const BellIcon = (p?: IconProps) =>
  icon(
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
    </>,
    p,
  );
