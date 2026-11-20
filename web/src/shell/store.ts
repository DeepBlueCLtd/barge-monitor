// Tiny observable stores shared by the shell and the display client.
import { useEffect, useState } from 'react';

export class Store<T> {
  private listeners = new Set<(v: T) => void>();
  constructor(public value: T) {}
  set(v: T) {
    this.value = v;
    this.listeners.forEach((l) => l(v));
  }
  subscribe(l: (v: T) => void) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
}

export function useStore<T>(s: Store<T>): T {
  const [v, setV] = useState(s.value);
  useEffect(() => s.subscribe(setV), [s]);
  return v;
}
