import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

interface EncryptedSecret {
  ciphertext: string;
  nonce: string;
  authTag: string;
}

function encryptionKey() {
  const key = Buffer.from(config.ENCRYPTION_KEY_BASE64, 'base64');
  if (key.byteLength !== 32 || key.toString('base64') !== config.ENCRYPTION_KEY_BASE64) {
    throw new Error('ENCRYPTION_KEY_BASE64 must encode exactly 32 random bytes.');
  }
  return key;
}

export function encryptSecret(value: string): EncryptedSecret {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(secret: EncryptedSecret): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(secret.nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(secret.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
