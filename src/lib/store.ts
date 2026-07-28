// Minimal external store — no dependencies, consumed via useSyncExternalStore.
import { useSyncExternalStore } from 'react';
import type { AppState } from './types';
import { initialState } from './data';

type Patch = Partial<AppState> | ((s: AppState) => Partial<AppState>);

class Store {
  private state: AppState = initialState();
  private listeners = new Set<() => void>();

  get = (): AppState => this.state;

  set = (patch: Patch): void => {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l());
  };

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  reset = (): void => {
    this.state = initialState();
    this.listeners.forEach((l) => l());
  };
}

export const store = new Store();

/** Subscribe a component to a slice of app state. */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
