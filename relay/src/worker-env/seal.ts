/**
 * Seals an env value for one laptop's public key, so only the laptop holding
 * the matching private key can open it. X25519 with a fresh key per value,
 * HKDF-SHA256, then AES-256-GCM. The entry's scope is the authenticated data,
 * so a sealed value moved onto another entry's row does not open.
 */

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto'

/** A laptop's key pair; `publicKey` and `privateKey` are base64 DER (SPKI and PKCS8). */
export type ReaderKey = { readonly fingerprint: string; readonly publicKey: string; readonly privateKey: string }

const VERSION = 'v1'
const INFO = Buffer.from('relay-worker-env v1')
const TAG_BYTES = 16

export function generateReaderKey(): ReaderKey {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const publicDer = publicKey.export({ type: 'spki', format: 'der' })
  return {
    fingerprint: fingerprintOf(publicDer.toString('base64')),
    publicKey: publicDer.toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }
}

/** The key pair stored in the keystore as its private half. */
export function readerKeyFromPrivate(privateKey: string): ReaderKey {
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' })
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64')
  return { fingerprint: fingerprintOf(publicKey), publicKey, privateKey }
}

/** sha256 of the public key's DER, hex. */
export function fingerprintOf(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex')
}

/** The authenticated data that ties a sealed value to its entry. */
export function sealContext(workspaceId: string, scope: { host: string; folder: string; name: string }): string {
  return JSON.stringify([workspaceId, scope.host, scope.folder, scope.name])
}

export function seal(value: string, publicKey: string, context: string): string {
  const recipient = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
  const ephemeral = generateKeyPairSync('x25519')
  const ephemeralPublic = ephemeral.publicKey.export({ type: 'spki', format: 'der' })
  const key = deriveKey(ephemeral.privateKey, recipient, ephemeralPublic, Buffer.from(publicKey, 'base64'))
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(context))
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [VERSION, ...[ephemeralPublic, iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url'))].join('.')
}

/** Throws when the value was not sealed for this key or context, or is not a sealed value; the error never holds the value. */
export function open(sealed: string, privateKey: string, context: string): string {
  const parts = sealed.split('.')
  const [version, ephemeralPublic, iv, tag, body] = parts
  if (parts.length !== 5 || version !== VERSION || ephemeralPublic === undefined || iv === undefined || tag === undefined || body === undefined) throw new Error('not a sealed env value')
  try {
    const ephemeralDer = Buffer.from(ephemeralPublic, 'base64url')
    const own = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' })
    const ownPublic = createPublicKey(own).export({ type: 'spki', format: 'der' })
    const key = deriveKey(own, createPublicKey({ key: ephemeralDer, format: 'der', type: 'spki' }), ephemeralDer, ownPublic)
    const authTag = Buffer.from(tag, 'base64url')
    if (authTag.length !== TAG_BYTES) throw new Error('short tag')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.from(context))
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('the env value does not open with this laptop key')
  }
}

/** HKDF over the shared secret, bound to both public keys (the fresh one as salt, the recipient's in the info). */
function deriveKey(privateKey: KeyObject, publicKey: KeyObject, ephemeralPublic: Buffer, recipientPublic: Buffer): Buffer {
  const shared = diffieHellman({ privateKey, publicKey })
  return Buffer.from(hkdfSync('sha256', shared, ephemeralPublic, Buffer.concat([INFO, recipientPublic]), 32))
}
