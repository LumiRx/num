// Procedural imagery — every booking/memory gets a lively gradient "scene"
// thumbnail with a category icon, inferred from its title/place. Self-contained
// (no image assets), consistent, and colorful without shouting.
import { useState } from 'react';
import type { CSSProperties } from 'react';
import {
  CameraIcon,
  DiningIcon,
  LandmarkIcon,
  LeafIcon,
  MusicIcon,
  PlaneIcon,
  RouteIcon,
  SparklesIcon,
  VideoIcon,
  WavesIcon,
} from './icons';
import type { IconProps } from './icons';

export interface SceneDef {
  gradient: string;
  Icon: (p?: IconProps) => JSX.Element;
}

const SCENES: Record<string, SceneDef> = {
  flight: { gradient: 'linear-gradient(135deg, #7cb8ff 0%, #3d6bff 100%)', Icon: PlaneIcon },
  boat: { gradient: 'linear-gradient(135deg, #4fd1c5 0%, #2b6cb0 100%)', Icon: WavesIcon },
  beach: { gradient: 'linear-gradient(135deg, #ffd36e 0%, #ff8a3d 100%)', Icon: WavesIcon },
  dining: { gradient: 'linear-gradient(135deg, #ff9a62 0%, #ec3013 100%)', Icon: DiningIcon },
  nightlife: { gradient: 'linear-gradient(135deg, #b06ab3 0%, #4568dc 100%)', Icon: MusicIcon },
  spa: { gradient: 'linear-gradient(135deg, #a8e063 0%, #38a169 100%)', Icon: LeafIcon },
  culture: { gradient: 'linear-gradient(135deg, #f6d365 0%, #c98a2c 100%)', Icon: LandmarkIcon },
  meeting: { gradient: 'linear-gradient(135deg, #94a3b8 0%, #475569 100%)', Icon: VideoIcon },
  memory: { gradient: 'linear-gradient(135deg, #fbc2eb 0%, #a18cd1 100%)', Icon: CameraIcon },
  trip: { gradient: 'linear-gradient(135deg, #ffb199 0%, #ff5a3c 100%)', Icon: RouteIcon },
};

const RULES: Array<[RegExp, keyof typeof SCENES]> = [
  [/flight|✈|airport|gate/i, 'flight'],
  [/ferry|boat|speedboat|long-tail|pier/i, 'boat'],
  [/beach|daybed|club — bang/i, 'beach'],
  [/dinner|lunch|omakase|bill|tasting|market|hawker|sushi|restaurant/i, 'dining'],
  [/party|bar|crawl|karaoke|fado|stadium|muay/i, 'nightlife'],
  [/massage|spa|ruen/i, 'spa'],
  [/palace|gallery|walk|wat |teamlab|temple/i, 'culture'],
  [/call|meeting|review|prep|catch-up|board/i, 'meeting'],
];

export function sceneFor(title: string, kind?: 'memory' | 'meeting'): SceneDef {
  if (kind === 'meeting') return SCENES.meeting;
  for (const [re, key] of RULES) if (re.test(title)) return SCENES[key];
  return kind === 'memory' ? SCENES.memory : SCENES.trip;
}

/** Rounded gradient thumbnail with the category icon — the app's "imagery". */
export function Scene({ title, kind, size = 42, style, photo }: { title: string; kind?: 'memory' | 'meeting'; size?: number; style?: CSSProperties; photo?: string }) {
  const s = sceneFor(title, kind);
  // A real photo when the directory has one; the gradient stays as the frame
  // beneath it, so a broken/slow image degrades to the icon rather than a hole.
  const [failed, setFailed] = useState(false);
  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.32,
        background: s.gradient,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        flex: 'none',
        overflow: 'hidden',
        boxShadow: '0 3px 10px rgba(32,30,29,.18), inset 0 1px 0 rgba(255,255,255,.35)',
        ...style,
      }}
    >
      {photo && !failed ? (
        <img
          src={photo}
          alt=""
          decoding="async"
          // No loading="lazy": these are 42px thumbnails always at or near the
          // viewport, and inside the auto-scrolled thread the lazy heuristic
          // could leave them permanently unloaded.
          onError={() => setFailed(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit', display: 'block' }}
        />
      ) : (
        <s.Icon size={Math.round(size * 0.5)} strokeWidth={2.1} />
      )}
    </div>
  );
}
