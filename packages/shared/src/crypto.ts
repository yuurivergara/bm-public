import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Envelope encryption.
 *
 * Cada segredo é cifrado com uma chave de dados aleatória (AES-256-GCM). A chave de dados é
 * "embrulhada" por um KeyProvider: em produção a AWS KMS; em dev/test uma chave mestra local.
 * O blob resultante é autocontido e pode ser gravado numa coluna bytea.
 *
 * Formato v1:
 *   [1 byte versão][2 bytes len keyId][keyId][2 bytes len wrapped][wrapped][12 iv][16 tag][ciphertext]
 */
export interface KeyProvider {
  readonly keyId: string;
  wrap(dataKey: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer, keyId: string): Promise<Buffer>;
}

const VERSION = 1;

export class LocalKeyProvider implements KeyProvider {
  readonly keyId: string;
  private readonly masterKey: Buffer;

  constructor(masterKeyBase64: string, keyId = 'local-v1') {
    const key = Buffer.from(masterKeyBase64, 'base64');
    if (key.length !== 32) throw new Error('LOCAL_MASTER_KEY deve ter 32 bytes em base64');
    this.masterKey = key;
    this.keyId = keyId;
  }

  async wrap(dataKey: Buffer): Promise<Buffer> {
    return aesGcmEncrypt(this.masterKey, dataKey);
  }

  async unwrap(wrapped: Buffer, keyId: string): Promise<Buffer> {
    if (keyId !== this.keyId) throw new Error(`Chave desconhecida: ${keyId}`);
    return aesGcmDecrypt(this.masterKey, wrapped);
  }
}

export async function encryptSecret(plaintext: string, provider: KeyProvider): Promise<Buffer> {
  const dataKey = randomBytes(32);
  try {
    const wrapped = await provider.wrap(dataKey);
    const body = aesGcmEncrypt(dataKey, Buffer.from(plaintext, 'utf8'));
    const keyId = Buffer.from(provider.keyId, 'utf8');
    const header = Buffer.alloc(1 + 2);
    header.writeUInt8(VERSION, 0);
    header.writeUInt16BE(keyId.length, 1);
    const wrappedLen = Buffer.alloc(2);
    wrappedLen.writeUInt16BE(wrapped.length, 0);
    return Buffer.concat([header, keyId, wrappedLen, wrapped, body]);
  } finally {
    dataKey.fill(0);
  }
}

export async function decryptSecret(blob: Buffer, provider: KeyProvider): Promise<string> {
  let offset = 0;
  const version = blob.readUInt8(offset);
  offset += 1;
  if (version !== VERSION) throw new Error(`Versão de envelope não suportada: ${version}`);
  const keyIdLen = blob.readUInt16BE(offset);
  offset += 2;
  const keyId = blob.subarray(offset, offset + keyIdLen).toString('utf8');
  offset += keyIdLen;
  const wrappedLen = blob.readUInt16BE(offset);
  offset += 2;
  const wrapped = blob.subarray(offset, offset + wrappedLen);
  offset += wrappedLen;
  const dataKey = await provider.unwrap(wrapped, keyId);
  try {
    return aesGcmDecrypt(dataKey, blob.subarray(offset)).toString('utf8');
  } finally {
    dataKey.fill(0);
  }
}

function aesGcmEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function aesGcmDecrypt(key: Buffer, payload: Buffer): Buffer {
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
}

/**
 * Hash de telefone por cliente (HMAC-SHA256 com chave derivada do pepper + tenantId).
 * O mesmo telefone gera hashes diferentes em clientes diferentes — impede correlação entre bases.
 */
export function hashPhone(e164: string, pepperBase64: string, tenantId: string): Buffer {
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(pepperBase64, 'base64'),
      Buffer.from(tenantId),
      'phone-hash',
      32,
    ),
  );
  return createHmac('sha256', key).update(e164).digest();
}

/** Token aleatório (url-safe) e seu hash SHA-256 para armazenamento. */
export function generateToken(bytes = 32): { token: string; hash: Buffer } {
  const token = randomBytes(bytes).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
