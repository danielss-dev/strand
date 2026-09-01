/** Initials chip for a commit author. Hue is a stable hash of the name. */
export function AuthorAvatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || '?';
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ background: `oklch(0.72 0.12 ${hue})` }}
    >
      {initials}
    </span>
  );
}
