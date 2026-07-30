// Minimal external store — no dependencies, consumed via useSyncExternalStore.
import { useSyncExternalStore } from 'react';
import type { AppState } from './types';
import { initialState, saveState } from './data';

type Patch = Partial<AppState> | ((s: AppState) => Partial<AppState>);

class Store {
  private state: AppState = initialState();
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  get = (): AppState => this.state;

  set = (patch: Patch): void => {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l());
    this.scheduleSave();
  };

  /** Swap the entire state (entering/leaving the demo trip). */
  replace = (next: AppState): void => {
    this.state = next;
    this.listeners.forEach((l) => l());
    this.scheduleSave();
  };

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  reset = (): void => {
    this.state = initialState();
    this.listeners.forEach((l) => l());
  };

  /** Debounced persistence — a burst of updates writes once. */
  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => saveState(this.state), 400);
  }
}

export const store = new Store();

/** Subscribe a component to a slice of app state. */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
