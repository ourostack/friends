// Observability seam.
//
// In the Ouroboros harness, the friend model emits structured "nerves" events
// through `emitNervesEvent` (from `nerves/runtime`). The standalone package must
// stay self-contained, so this module ships a no-op `emitNervesEvent` with the
// SAME signature as the harness's, plus `setNervesEmitter(fn)` — an injection
// point the harness (or any consumer) can use to wire its real emitter back in.
//
// Default behavior: events are dropped. Call `setNervesEmitter` once at startup
// to forward them somewhere real.

/** Log severity for an emitted event. Mirrors the harness's `LogLevel`. */
export type LogLevel = "debug" | "info" | "warn" | "error"

/**
 * A structured observability event. Field-for-field identical to the harness's
 * `NervesEvent` so the harness's real emitter can be injected without adaptation.
 */
export interface NervesEvent {
  level?: LogLevel
  event: string
  trace_id?: string
  component: string
  message: string
  meta?: Record<string, unknown>
}

/** A function that consumes emitted events. */
export type NervesEmitter = (event: NervesEvent) => void

const noopEmitter: NervesEmitter = () => {}

let activeEmitter: NervesEmitter = noopEmitter

/**
 * Inject the emitter that `emitNervesEvent` should forward to. Pass `null` to
 * reset back to the default no-op. The harness passes its real nerves emitter
 * here so extracted friend code reports through the same observability pipeline.
 */
export function setNervesEmitter(emitter: NervesEmitter | null): void {
  activeEmitter = emitter ?? noopEmitter
}

/**
 * Emit a structured observability event. No-op by default; forwards to whatever
 * was last passed to `setNervesEmitter`.
 */
export function emitNervesEvent(event: NervesEvent): void {
  activeEmitter(event)
}
