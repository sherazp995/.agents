/**
 * A process-wide registry of secret values that must never appear in any
 * text that leaves relay: doctor output, an unexpected exception message,
 * anything printed to a terminal. This is the backstop for FR-SEC-1.
 *
 * Redacting a known token at the point it is used, such as redactToken in
 * src/doctor/checks/slack.ts, stays correct and stays in place; that
 * redaction knows exactly which text is safe to keep (a Slack error code
 * from a fixed allowlist) and this module does not try to replace that
 * judgement. What this module closes is the gap a construction site can
 * leave by accident: a secret read outside a try block, a future check
 * author who forgets to call a redaction helper, a future SecretProvider
 * that is not as careful as the ones today. SecretProvider.get is the
 * single choke point every secret value passes through on its way into the
 * process, so registering a value there, in both KeychainSecretProvider and
 * EnvSecretProvider, makes this protection the default for every value that
 * ever enters relay rather than something each call site has to opt into.
 *
 * The registered values are never exposed back out of this module. There is
 * no getter, no iteration, and no way to ask "what is registered" from
 * outside this file, only registerSecretValue and scrubSecrets are exported
 * for production use. Nothing here logs what it scrubbed either: doing so
 * would just relocate the leak into whatever logged the scrub event.
 */

/**
 * Values shorter than this are ignored rather than registered. A secret
 * this short would turn scrubSecrets into a blunt instrument: a
 * one-character value could match somewhere inside almost every line of
 * real output, replacing ordinary words and punctuation with placeholders
 * throughout the entire doctor report rather than protecting a genuine
 * secret. Eight is comfortably below every secret relay registers today,
 * Slack bot and app tokens are all well over twenty characters, so real
 * secrets are unaffected; it exists only as a floor against a pathological
 * short value swallowing unrelated output.
 */
const MINIMUM_SECRET_LENGTH = 8

/**
 * Fixed replacement text. Deliberately carries no length or prefix hint of
 * the value it replaced: either would narrow what an attacker reading the
 * output has to guess, which makes the placeholder itself a partial leak.
 */
const PLACEHOLDER = '[redacted secret]'

const registeredValues = new Set<string>()

/**
 * Records a value that must never appear in output leaving relay. Safe to
 * call with the same value more than once. Values shorter than
 * MINIMUM_SECRET_LENGTH are silently ignored rather than registered.
 */
export function registerSecretValue(value: string): void {
  if (value.length < MINIMUM_SECRET_LENGTH) return
  registeredValues.add(value)
}

/**
 * Replaces every occurrence of every registered secret value with a fixed
 * placeholder. Intended for use at an output boundary, such as
 * runCheckSafely's catch block and formatResults, not as a substitute for
 * redacting at the point a value is used: it is the backstop for whatever a
 * construction site's own redaction does not catch.
 */
export function scrubSecrets(text: string): string {
  let result = text
  for (const value of registeredValues) {
    result = result.split(value).join(PLACEHOLDER)
  }
  return result
}

/**
 * Clears every registered value. Test-only: production code has no reason
 * to ever forget a secret mid-process, since the placeholder never reveals
 * that a value existed in the first place, so there is nothing for
 * production code to gain by clearing the registry.
 */
export function resetSecretScrubberForTests(): void {
  registeredValues.clear()
}
