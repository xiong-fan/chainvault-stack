import * as nacl from 'tweetnacl';

export interface SignaturePayload {
  operation_id: string;
  operation_type: string;
  table?: string;
  action?: string;
  data?: any;
  conditions?: any;
  operations?: any[];
  timestamp: number;
}

export class Ed25519Signer {
  private secretKey: Uint8Array;
  private publicKey: Uint8Array;

  constructor() {
    const privateKeyHex = process.env.SCAN_SOLANA_PRIVATE_KEY || process.env.DB_GATEWAY_SECRET;

    if (privateKeyHex) {
      this.secretKey = this.hexToUint8Array(privateKeyHex);

      if (this.secretKey.length !== 64) {
        throw new Error(`Solana scan private key must be 64 bytes, got ${this.secretKey.length}`);
      }

      this.publicKey = this.secretKey.slice(32, 64);
    } else {
      throw new Error('SCAN_SOLANA_PRIVATE_KEY is required for Solana scan signing (DB_GATEWAY_SECRET is supported only as legacy fallback)');
    }
  }

  /**
   * 对数据进行签名
   */
  sign(payload: SignaturePayload): string {
    // 对 payload 进行规范化排序并序列化
    const message = this.serializePayload(payload);
    const messageBytes = new TextEncoder().encode(message);

    // 使用 Ed25519 签名
    const signature = nacl.sign.detached(messageBytes, this.secretKey);

    // 返回十六进制格式的签名
    return this.uint8ArrayToHex(signature);
  }

  /**
   * 验证签名
   */
  verify(payload: SignaturePayload, signatureHex: string, publicKeyHex: string): boolean {
    const message = this.serializePayload(payload);
    const messageBytes = new TextEncoder().encode(message);
    const signature = this.hexToUint8Array(signatureHex);
    const publicKey = this.hexToUint8Array(publicKeyHex);

    return nacl.sign.detached.verify(messageBytes, signature, publicKey);
  }

  /**
   * 序列化 payload 为字符串
   * 必须与 db_gateway 使用的顺序保持一致
   */
  private serializePayload(payload: SignaturePayload): string {
    if (payload.operations) {
      return JSON.stringify({
        operation_id: payload.operation_id,
        operation_type: payload.operation_type,
        data: null,
        conditions: null,
        timestamp: payload.timestamp
      });
    }

    return JSON.stringify({
      operation_id: payload.operation_id,
      operation_type: payload.operation_type,
      table: payload.table,
      action: payload.action,
      data: payload.data ?? null,
      conditions: payload.conditions ?? null,
      timestamp: payload.timestamp
    });
  }

  /**
   * 将 Uint8Array 转换为十六进制字符串
   */
  private uint8ArrayToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * 将十六进制字符串转换为 Uint8Array
   */
  private hexToUint8Array(hex: string): Uint8Array {
    if (hex.startsWith('0x')) {
      hex = hex.slice(2);
    }

    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error('Invalid hex string');
    }

    const matches = hex.match(/.{1,2}/g);
    if (!matches) {
      throw new Error('Invalid hex string');
    }
    return new Uint8Array(matches.map(byte => parseInt(byte, 16)));
  }

  /**
   * 获取公钥（十六进制格式）
   */
  getPublicKeyHex(): string {
    return this.uint8ArrayToHex(this.publicKey);
  }
}
