// UI-level events between the keyboard layer and mounted components.
type Handler = (arg?: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

export function emit(name: string, arg?: unknown): void {
  handlers.get(name)?.forEach((h) => h(arg));
}

export function on(name: string, h: Handler): () => void {
  let set = handlers.get(name);
  if (!set) handlers.set(name, (set = new Set()));
  set.add(h);
  return () => set!.delete(h);
}
