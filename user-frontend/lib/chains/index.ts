import { SupportedChainType } from '../types';

export const CHAIN_OPTIONS: { label: string; value: SupportedChainType; chainId: number }[] = [
  { label: 'EVM Sepolia', value: 'evm', chainId: 11155111 },
  { label: 'Solana', value: 'solana', chainId: 900 },
  { label: 'BTC', value: 'btc', chainId: 0 }
];

export function defaultChainId(chainType: SupportedChainType): number {
  if (chainType === 'evm') return 11155111;
  if (chainType === 'solana') return 900;
  return 0;
}

export function formatChainTypeLabel(value: SupportedChainType): string {
  return value === 'evm' ? 'EVM' : value === 'solana' ? 'Solana' : 'Bitcoin';
}
