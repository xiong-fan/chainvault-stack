import * as nacl from 'tweetnacl';

export interface SignaturePayload {
  operation_id: string;
  operation_type: string;
  table: string;
  action: string;
  data?: unknown;
  conditions?: unknown;
  timestamp: number;
}

export class Ed25519Signer {
  private readonly privateKey: Uint8Array;

  constructor(privateKeyHex: string) {
    this.privateKey = this.hexToUint8Array(privateKeyHex);
  }

  sign(payload: SignaturePayload): string {
    return this.signMessage(this.createSignaturePayload(payload));
  }

  signMessage(message: string): string {
    const messageBytes = new TextEncoder().encode(message);
    const signature = nacl.sign.detached(messageBytes, this.privateKey);
    return this.uint8ArrayToHex(signature);
  }

  createSignaturePayload(payload: SignaturePayload): string {
    return JSON.stringify({
      operation_id: payload.operation_id,
      operation_type: payload.operation_type,
      table: payload.table,
      action: payload.action,
      data: payload.data || null,
      conditions: payload.conditions || null,
      timestamp: payload.timestamp
    });
  }

  private hexToUint8Array(hex: string): Uint8Array {
    const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bytes = new Uint8Array(normalized.length / 2);
    for (let i = 0; i < normalized.length; i += 2) {
      bytes[i / 2] = Number.parseInt(normalized.substring(i, i + 2), 16);
    }
    return bytes;
  }

  private uint8ArrayToHex(array: Uint8Array): string {
    return Array.from(array)
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
  }
}
