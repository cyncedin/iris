import { EventEmitter } from "node:events";
import type { IrisEvent } from "./types.ts";

export class Bus extends EventEmitter {
  emitEvent(e: Omit<IrisEvent, "at">): void {
    this.emit("event", { ...e, at: Date.now() } satisfies IrisEvent);
  }
  onEvent(fn: (e: IrisEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}
