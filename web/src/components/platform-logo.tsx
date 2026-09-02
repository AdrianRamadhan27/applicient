// Small colored mark for a job source/platform (Greenhouse, LinkedIn,
// ...) — originally local to radar/page.tsx's "New saved search"
// source picker, extracted so the Job Inbox card list can render the
// same badge per job (raised directly by Adrian).
export function PlatformLogo({ mark, color, size = 26 }: { mark: string; color: string; size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center shrink-0 font-mono font-bold text-white leading-none"
      style={{ backgroundColor: color, width: size, height: size, fontSize: size * 0.42 }}
    >
      {mark}
    </span>
  );
}
