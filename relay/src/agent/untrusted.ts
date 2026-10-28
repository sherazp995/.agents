/**
 * The boundary around content Relay did not author: a Slack message body, a
 * file name, the raw platform payload `ChatEvent.raw` carries for audit. Per
 * AP-2, outside content is data, never instruction, and must never be
 * concatenated into a system prompt. Closes P0.1 gate item I-2: `raw` used to
 * be typed `unknown` with a comment saying "never feed this to a model",
 * and a comment is not a boundary. `unknown` blocks property access, but it
 * does nothing to stop `${event.raw}`, `JSON.stringify(event.raw)`, or
 * handing the value to a function whose own parameter is also typed
 * `unknown`, which is exactly the shape a model-call function tends to have.
 *
 * DESIGN DECISION: how nominal is the wrapper.
 *
 * Two options were on the table. A branded type
 * (`type Untrusted<T> = T & { readonly __brand: unique symbol }`) is
 * compile-time only: it is erased at build time, so at runtime a "wrapped"
 * value is literally the same object as the value it wraps, with no
 * defences of its own. `JSON.stringify` on a branded value would still
 * print the whole payload, and `${brandedValue}` would still interpolate
 * it, because the brand never existed once `tsc` finished. It would satisfy
 * only the narrowest reading of "nominal": TypeScript refuses to assign a
 * bare `T` where `Untrusted<T>` is expected, and nothing else.
 *
 * This module instead uses a class with a true private field (`#value`).
 * That buys two things a branded type cannot: TypeScript private class
 * fields make the class nominal for real (structural typing does not apply
 * once a class has a private member, so no other object, however shaped,
 * satisfies this class's type without literally being an instance of it),
 * and the field is enforced by the JavaScript runtime itself, not merely by
 * the type checker. `JSON.stringify`, `Object.keys`, `for...in`,
 * `Reflect.ownKeys`, and object spread all skip private fields entirely,
 * because a private field is not a property key at all; it lives in an
 * internal slot the language never exposes to reflection. That is what
 * makes the "JSON.stringify does not expose the payload" test below hold
 * for a genuine reason, not an accident of what happens to be implemented
 * today.
 *
 * The cost: this is heavier than a branded type (an actual object
 * allocation per wrap, a class definition to maintain) and it does not
 * survive `structuredClone` or a naive JSON round trip. `structuredClone`
 * cannot see a private field either, so cloning a wrapped value silently
 * produces an empty object rather than throwing or preserving the payload.
 * Nothing in Relay today calls `structuredClone` on a `ChatEvent` or
 * persists one as JSON (checked at the time this module was written), so
 * this is a live cost to note rather than a bug to fix now: the moment a
 * future task needs to move a wrapped value across a worker boundary or
 * into storage, it needs an explicit, deliberate (de)serialisation path
 * through `unwrapForAudit`, not an implicit clone.
 *
 * DESIGN DECISION: what provenance tagging looks like in renderForModel.
 *
 * A naive delimiter, `<user>${text}</user>` built by string concatenation,
 * is not sufficient, because the untrusted text can itself contain the
 * literal substring `</user>` followed by whatever instruction the sender
 * wants the model to treat as real. That is not hypothetical; it is exactly
 * how prompt injection against a naive wrapper works, and it is exactly
 * what the adversarial test below constructs.
 *
 * renderForModel instead JSON-encodes the payload with `JSON.stringify`
 * before placing it inside a fixed tag pair. JSON string escaping is a
 * total, well-defined function: every `"` in the content becomes `\"`,
 * every newline becomes `\n`, every backslash becomes `\\`. The content can
 * still CONTAIN the literal text of the tag (JSON does not escape `<`, `>`,
 * or `/`), but it can only appear as literal characters inside a single,
 * unbroken, properly escaped JSON string, never as an unescaped `"` that
 * could terminate the string early and hand the model a syntactically new
 * boundary. The output is therefore always exactly: the opening tag, one
 * complete JSON string literal, the closing tag, with no way for the
 * payload to introduce a second real opening or closing tag of its own.
 * The adversarial test proves this mechanically: it recovers the injected
 * payload byte for byte via `JSON.parse` on the slice between the outer
 * tags, including the fake tag text embedded inside it, proving that fake
 * text never became a structural boundary.
 *
 * What this does NOT prove, stated plainly per the task's own instruction
 * that an overstated boundary is worse than an honestly described one: it
 * does not prove a model reading this text will always treat the quoted
 * region as pure data. A model is a probabilistic reader, not a JSON
 * parser; sufficiently adversarial content inside the quotes can still try
 * to talk the model into ignoring the quoting, the same way it could try to
 * talk a human proofreader into it. renderForModel removes the STRUCTURAL
 * ambiguity (there is no way to fake a real tag boundary), not the semantic
 * one (there is no way to guarantee the reader is never persuaded by
 * whatever is inside the quotes). See "What a determined caller can still
 * do" in the task report for the full list of gaps this boundary does not
 * close.
 *
 * renderForModel also runs its output through src/secrets/scrubber.ts's
 * `scrubSecrets` before returning. Outside content can itself contain a
 * secret, most plausibly an operator pasting a real token into a Slack
 * message by mistake, and that string is exactly the kind of thing
 * `registerSecretValue` would already have registered when Relay's own
 * `SecretProvider` read it. Without this, a prompt or a log line built from
 * renderForModel's output would put that secret back in the clear, undoing
 * the scrubber's protection at the one place this module exists to guard.
 * This module does not otherwise change scrubber.ts, which the task brief
 * says to consume as-is.
 */

import { scrubSecrets } from '../secrets/scrubber.js'

/**
 * The actual box. Not exported: the only way to construct one is
 * `wrapUntrusted`, and the only way to read the payload back out is
 * `unwrapForAudit` (both defined below, both reaching `#value` because they
 * are lexically inside this class body, which is what private fields
 * require). Nothing outside this module can call `new UntrustedBox(...)`,
 * reach `.reveal`, or otherwise construct a fake instance: TypeScript's
 * structural typing does not apply to a class with a private member, so no
 * externally built object, however shaped, is assignable to this type.
 */
class UntrustedBox<T> {
  readonly #value: T

  private constructor(value: T) {
    this.#value = value
  }

  static create<T>(value: T): UntrustedBox<T> {
    return new UntrustedBox(value)
  }

  /** Only callable from inside this module: see `reveal` below, the single place that calls it. */
  static reveal<T>(box: UntrustedBox<T>): T {
    return box.#value
  }

  /**
   * Deliberately never the payload. `${wrapped}` and template literal
   * interpolation both call this, and both get a fixed, safe marker rather
   * than anything from `#value`. Kept explicit rather than relying on the
   * default `Object.prototype.toString` (which would already print
   * `[object Object]`, equally safe but less informative about why): a
   * reader who sees this string in output has enough context to go find
   * `renderForModel` instead of wondering what went wrong.
   */
  toString(): string {
    return '[Untrusted value: call renderForModel(), never string-interpolate this]'
  }

  /**
   * Deliberately never the payload either. `JSON.stringify` would already
   * skip the private field on its own (private fields are not property
   * keys, so no reflection API can see them), but that would make the
   * "does not expose the payload" property an implementation accident
   * rather than a decision. Returning the same marker as `toString` makes
   * it a decision, and keeps `JSON.stringify(wrapped)` informative instead
   * of a bare `{}}` that could be mistaken for an empty payload rather than
   * a deliberately withheld one.
   */
  toJSON(): string {
    return this.toString()
  }
}

/**
 * The wrapper type. An alias to the unexported class above, so a caller can
 * write `Untrusted<string>` in a type position (as `ChatEvent` does for
 * `raw` and `text`) without ever being able to name, construct, or read
 * past it except through `wrapUntrusted` and `unwrapForAudit`.
 */
export type Untrusted<T> = UntrustedBox<T>

/**
 * The only sanctioned way to produce an `Untrusted<T>`. Called once, at the
 * boundary where outside content first enters Relay (a chat adapter
 * building a `ChatEvent`), never deep inside a call chain where it would be
 * easy to mistake a pre-wrapped value for a value still needing to be
 * wrapped.
 */
export function wrapUntrusted<T>(value: T): Untrusted<T> {
  return UntrustedBox.create(value)
}

/**
 * The one escape hatch, named so a reader at the call site sees exactly
 * what they are declaring: "I am reading this for audit, not to build a
 * prompt with it." Nothing about the name or the type system stops a
 * careless or malicious caller from taking the returned `T` and handing it
 * to a model anyway; see "what a determined caller can still do" in the
 * task report. What this closes is the ACCIDENTAL path: a value typed
 * `Untrusted<T>` cannot be interpolated, spread, JSON.stringify'd, or
 * destructured into something that looks like ordinary data by mistake. It
 * takes a deliberate, named call to get the payload back.
 */
export function unwrapForAudit<T>(wrapped: Untrusted<T>): T {
  return UntrustedBox.reveal(wrapped)
}

/** The literal tag pair renderForModel wraps every payload in. Exported only for the adversarial test, which needs to name the exact string it is trying to forge. */
export const UNTRUSTED_DATA_TAG = 'relay:untrusted-data'

const OPEN_TAG = `<${UNTRUSTED_DATA_TAG}>`
const CLOSE_TAG = `</${UNTRUSTED_DATA_TAG}>`

/**
 * Serialises `payload` the way `JSON.stringify` would for any value that is
 * not itself directly stringifiable (`undefined`, a function, a value with
 * a circular reference). `JSON.stringify` returns `undefined` (the JS
 * value, not the string `"undefined"`) for some inputs rather than
 * throwing, and throws outright for a circular structure; both are folded
 * into a stringified fallback here so renderForModel always returns a
 * string, never `undefined`, and never throws on content it cannot fully
 * serialise. The fallback still goes through JSON.stringify on the coerced
 * string, so it gets the same escaping guarantee as the normal path.
 */
function serializeForRender(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload)
    if (serialized !== undefined) return serialized
    return JSON.stringify(String(payload))
  } catch {
    return JSON.stringify(String(payload))
  }
}

/**
 * The ONLY sanctioned path by which outside content reaches a prompt, per
 * AP-2. Unwraps internally (it is defined in this module, so it can), then
 * renders the payload as a single JSON string literal inside a fixed tag
 * pair, so a caller assembling a prompt has one line to write
 * (`renderForModel(event.text)`) and never touches the raw payload itself.
 *
 * This function tags provenance; it does not decide WHERE in a prompt the
 * result goes. A caller that concatenates this function's return value
 * into a system prompt string has still violated AP-2's "never
 * concatenated into a system prompt" clause even though the content itself
 * is correctly tagged as data. See the design comment at the top of this
 * file, and "what a determined caller can still do" in the task report.
 */
export function renderForModel<T>(wrapped: Untrusted<T>): string {
  const payload = UntrustedBox.reveal(wrapped)
  const rendered = `${OPEN_TAG}${serializeForRender(payload)}${CLOSE_TAG}`
  return scrubSecrets(rendered)
}
