/**
 * Drag-to-resize for the layout's panels. A size is remembered in localStorage (per browser), and a
 * double-click on the divider puts it back to the default.
 */
import { useCallback, useState, type PointerEvent as ReactPointerEvent } from 'react';

function read(key: string): number | null {
  try {
    const v = Number(window.localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function write(key: string, value: number | null): void {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // storage unavailable
  }
}

interface Options {
  /** x resizes a width, y a height. */
  axis: 'x' | 'y';
  /** True when dragging towards the start (left / up) makes the panel bigger. */
  invert?: boolean;
  min: number;
  /** Upper bound, read at drag time so it follows the window. */
  max: () => number;
}

/**
 * The size (null = the layout's default) and the divider's handlers. `measure` gives the panel's current
 * size when a drag starts from the default.
 */
export function useResizable(key: string, o: Options) {
  const [size, setSize] = useState<number | null>(() => read(key));
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, measure: () => number) => {
      e.preventDefault();
      const pos = (ev: { clientX: number; clientY: number }) => (o.axis === 'x' ? ev.clientX : ev.clientY);
      const start = pos(e);
      const startSize = size ?? measure();
      let latest = startSize;
      document.body.classList.add(o.axis === 'x' ? 'resizing-x' : 'resizing-y');
      const move = (m: PointerEvent) => {
        const delta = pos(m) - start;
        latest = Math.max(o.min, Math.min(o.max(), startSize + (o.invert ? -delta : delta)));
        setSize(latest);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.classList.remove('resizing-x', 'resizing-y');
        write(key, latest);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [key, o, size],
  );
  const reset = useCallback(() => {
    setSize(null);
    write(key, null);
  }, [key]);
  return { size, onPointerDown, reset };
}
