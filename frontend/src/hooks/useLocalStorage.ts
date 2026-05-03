import { useState, useEffect, useCallback } from 'react';

type Setter<T> = (value: T | ((prev: T) => T)) => void;

/**
 * Persist state to localStorage
 */
export function useLocalStorage<T>(key: string, initialValue: T): [T, Setter<T>, () => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initialValue;
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) as T : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(key, JSON.stringify(storedValue));
    } catch {
      // Silently fail
    }
  }, [key, storedValue]);

  const setValue: Setter<T> = useCallback((value) => {
    setStoredValue((prev) => {
      if (typeof value === 'function') {
        return (value as (p: T) => T)(prev);
      }
      return value;
    });
  }, []);

  const clearValue = useCallback(() => {
    setStoredValue(initialValue);
    if (typeof window !== 'undefined') {
      localStorage.removeItem(key);
    }
  }, [key, initialValue]);

  return [storedValue, setValue, clearValue];
}

/**
 * Detect system dark/light mode preference
 */
export function useSystemTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window === 'undefined') return 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return theme;
}

/**
 * Detect when user has scrolled up in a container
 */
export function useScrollPosition(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  useEffect(() => {
    const el = ref?.current;
    if (!el) return;
    const handler = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      setIsScrolledUp(dist > 100);
    };
    el.addEventListener('scroll', handler, { passive: true });
    handler();
    return () => el.removeEventListener('scroll', handler);
  }, [ref]);

  return isScrolledUp;
}
