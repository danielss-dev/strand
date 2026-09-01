import { useMemo, useRef, useState } from 'react';

import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { useRepoIcons } from '../stores/repoIcons';
import { tileGlyph } from '../lib/repoIdentity';
import type { RepoIcon } from '../lib/types';

/** Palette swatches available for the tile background (branch-lane colors). */
const SWATCHES = ['--b-1', '--b-2', '--b-3', '--b-4', '--b-5', '--b-6', '--b-7'];

/** Longest edge of a stored tile image — keeps the data URL small in SQLite. */
const IMAGE_MAX = 96;

/** Cap on a stored SVG's source so the data URL stays reasonable in SQLite. */
const SVG_MAX_BYTES = 64 * 1024;

/** True for SVG picks — kept as vector markup instead of rasterized. */
const isSvgFile = (file: File): boolean =>
  file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);

/**
 * Store a picked SVG as a base64 `image/svg+xml` data URL — vector, so it stays
 * crisp at any tile size, unlike the raster path below. Rendered through the
 * same `<img>` the other formats use; loading SVG via `<img>` neuters scripts
 * and external fetches, so untrusted files are safe to display.
 */
async function svgToTileDataUrl(file: File): Promise<string> {
  const text = await file.text();
  if (text.length > SVG_MAX_BYTES) throw new Error('SVG is too large (max 64 KB)');
  if (!/<svg[\s>]/i.test(text)) throw new Error('Not a valid SVG');
  // UTF-8-safe base64 (btoa is latin1-only).
  const b64 = btoa(unescape(encodeURIComponent(text)));
  return `data:image/svg+xml;base64,${b64}`;
}

/**
 * Convert a picked image file to a small data URL for the tile. SVGs keep their
 * vector markup; everything else is downscaled to a square-ish PNG (≤ IMAGE_MAX
 * on its longest edge) so it stays tiny in the settings table. Done entirely in
 * the webview — no Tauri fs plugin needed.
 */
function fileToTileDataUrl(file: File): Promise<string> {
  if (isSvgFile(file)) return svgToTileDataUrl(file);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, IMAGE_MAX / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read image'));
    };
    img.src = url;
  });
}

/**
 * Customize a repo's rail tile: background color, initials override, emoji, or
 * a custom image. Image wins over emoji wins over letter for the glyph; color
 * is the background in every case. Empty fields fall back to the derived
 * defaults (initials from the repo name, a color hashed from its git dir).
 */
export function RepoIconDialog({
  path,
  name,
  onClose,
}: {
  path: string;
  name: string;
  onClose: () => void;
}) {
  const saved = useRepoIcons((s) => s.icons[path]);
  const setIcon = useRepoIcons((s) => s.setIcon);
  const clearIcon = useRepoIcons((s) => s.clearIcon);

  const [color, setColor] = useState<string | null>(saved?.color ?? null);
  const [letter, setLetter] = useState(saved?.letter ?? '');
  const [emoji, setEmoji] = useState(saved?.emoji ?? '');
  const [image, setImage] = useState<string | null>(saved?.image ?? null);
  const [error, setError] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  const draft: RepoIcon = useMemo(
    () => ({ color, letter, emoji, image }),
    [color, letter, emoji, image],
  );
  // No custom color ⇒ the tile shows the configured app accent (`--accent-base`,
  // matching the rail) and selecting this repo keeps the accent as-is. A picked
  // swatch re-themes the accent when active.
  const previewColor = color || 'var(--accent-base)';

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    try {
      setImage(await fileToTileDataUrl(file));
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Could not read image');
    }
  };

  const save = async () => {
    await setIcon(path, draft);
    onClose();
  };

  const reset = async () => {
    await clearIcon(path);
    onClose();
  };

  return (
    <Dialog
      title="Customize icon"
      icon="edit"
      className="repo-icon-dialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost ri-reset" onClick={() => void reset()}>
            Reset to default
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => void save()}>Save</button>
        </>
      }
    >
      <div className="clone-body">
        <div className="ri-preview-row">
          <div className="ri-preview" style={image ? undefined : { background: previewColor }}>
            {image
              ? <img src={image} alt="" />
              : <span className={emoji.trim() ? 'emoji' : undefined}>{tileGlyph(draft, name)}</span>}
          </div>
          <div className="ri-preview-meta">
            <div className="ri-name">{name}</div>
            <div className="ri-hint">Preview of the rail tile.</div>
          </div>
        </div>

        <label className="clone-field">
          <span className="lbl">Color</span>
          <div className="ri-swatches">
            <button
              type="button"
              className={'ri-swatch default' + (color === null ? ' on' : '')}
              title="Default (app accent)"
              aria-label="Default color (app accent)"
              onClick={() => setColor(null)}
              style={{ background: 'var(--accent-base)' }}
            >
              {color === null && <Icon name="check" size={12} stroke={2.4} />}
            </button>
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                className={'ri-swatch' + (color === `var(${c})` ? ' on' : '')}
                aria-label={`Color ${c}`}
                onClick={() => setColor(`var(${c})`)}
                style={{ background: `var(${c})` }}
              >
                {color === `var(${c})` && <Icon name="check" size={12} stroke={2.4} />}
              </button>
            ))}
          </div>
        </label>

        <div className="ri-fields">
          <label className="clone-field">
            <span className="lbl">Initials</span>
            <input
              className="clone-input"
              placeholder={tileGlyph({ ...draft, letter: '', emoji: '' }, name)}
              value={letter}
              maxLength={2}
              onChange={(e) => setLetter(e.target.value.slice(0, 2))}
            />
          </label>
          <label className="clone-field">
            <span className="lbl">Emoji</span>
            <input
              className="clone-input"
              placeholder="🚀"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
            />
          </label>
        </div>

        <label className="clone-field">
          <span className="lbl">Image</span>
          <div className="ri-image-row">
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
              <Icon name="file" size={13} /> {image ? 'Replace image…' : 'Choose image…'}
            </button>
            {image && (
              <button type="button" className="btn ghost" onClick={() => setImage(null)}>
                Remove image
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*,.svg"
              hidden
              onChange={(e) => void onPickFile(e)}
            />
          </div>
        </label>

        <div className="stash-note">
          {image
            ? 'Image overrides the emoji and initials.'
            : emoji.trim()
              ? 'Emoji overrides the initials.'
              : 'Leave fields empty to use the repo’s initials and auto color.'}
        </div>

        {error && <div className="clone-error">{error}</div>}
      </div>
    </Dialog>
  );
}
