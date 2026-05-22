export function toChecksumHexOrOriginal(address = ''): string {
  return address;
}

export function formatAddress(address = '', head = 6, tail = 4): string {
  if (!address) return '--';
  if (address.length <= head + tail + 3) return address;
  return `${address.slice(0, head)}...${address.slice(-tail)}`;
}

export function isValidAddress(address: string, chainType: 'evm' | 'solana' | 'btc'): boolean {
  if (!address) return false;
  if (chainType === 'evm') {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  if (chainType === 'solana') {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }

  return /^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,89}$/.test(address);
}
