'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { SupportedChainType } from '@/lib/types';
import { CHAIN_OPTIONS, defaultChainId, formatChainTypeLabel } from '@/lib/chains';
import { isValidAddress } from '@/lib/format/address';
import { clampNumericInput } from '@/lib/format/number';
import type { BalanceDetailItem, WalletTokenConfig } from '@/types/api/wallet';

interface WithdrawFormValues {
  chainType: SupportedChainType;
  chainId: number;
  tokenId: number;
  to: string;
  amount: string;
}

interface WithdrawFormProps {
  onSubmit: (next: WithdrawFormValues) => Promise<{ ok: boolean } | void>;
  isPending: boolean;
  tokens: WalletTokenConfig[];
  tokensLoading?: boolean;
  balances?: BalanceDetailItem[];
  balancesLoading?: boolean;
}

function shortAddress(address?: string | null) {
  if (!address) return '原生币';
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

export function WithdrawForm({
  onSubmit,
  isPending,
  tokens,
  tokensLoading = false,
  balances = [],
  balancesLoading = false
}: WithdrawFormProps) {
  const [chainType, setChainType] = useState<SupportedChainType>('evm');
  const [tokenId, setTokenId] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');

  const selectedChainId = CHAIN_OPTIONS.find((item) => item.value === chainType)?.chainId ?? defaultChainId(chainType);
  const scopedTokens = useMemo(() => {
    return tokens.filter((item) => item.chain_type === chainType && item.chain_id === selectedChainId && Number(item.status) === 1);
  }, [chainType, selectedChainId, tokens]);
  const selectedToken = scopedTokens.find((item) => String(item.id) === tokenId);
  const selectedBalance = selectedToken
    ? balances.find((item) => item.token_id === selectedToken.id && item.chain_type === chainType && item.chain_id === selectedChainId)
    : undefined;
  const maxWithdrawBalance = selectedBalance?.available_balance_formatted || '0';
  const isAddressValid = isValidAddress(to, chainType);
  const isAmountPositive = Number.parseFloat(amount) > 0;
  const canSubmit =
    to.length > 0 &&
    Boolean(selectedToken) &&
    isAmountPositive &&
    isAddressValid &&
    !isPending;

  useEffect(() => {
    if (scopedTokens.length === 0) {
      setTokenId('');
      return;
    }

    if (!scopedTokens.some((item) => String(item.id) === tokenId)) {
      setTokenId(String(scopedTokens[0]!.id));
    }
  }, [scopedTokens, tokenId]);

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <label className="text-sm text-muted-foreground">链类型</label>
        <select
          value={chainType}
          onChange={(e) => setChainType(e.target.value as SupportedChainType)}
          className="h-10 rounded-lg border border-border bg-background px-3"
        >
          {CHAIN_OPTIONS.map((item) => (
            <option key={item.value} value={item.value}>
              {formatChainTypeLabel(item.value)} ({item.chainId})
            </option>
          ))}
        </select>
      </div>

      <TextField
        label="链 ID"
        value={String(selectedChainId)}
        onChange={() => undefined}
        disabled
      />

      <label className="grid gap-1 text-sm">
        <span className="text-muted-foreground">提现代币</span>
        <select
          value={tokenId}
          onChange={(event) => setTokenId(event.target.value)}
          disabled={tokensLoading || scopedTokens.length === 0}
          className="h-11 rounded-lg border border-border bg-background px-3 text-foreground outline-none transition duration-200 focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
        >
          {tokensLoading ? <option value="">加载代币中...</option> : null}
          {!tokensLoading && scopedTokens.length === 0 ? <option value="">当前网络暂无可提现代币</option> : null}
          {scopedTokens.map((item) => (
            <option key={item.id} value={item.id}>
              {item.token_symbol} - {item.token_name || item.token_symbol} / {shortAddress(item.token_address)}
            </option>
          ))}
        </select>
      </label>

      <TextField
        label={`目标地址 (${formatChainTypeLabel(chainType)})`}
        value={to}
        onChange={(value) => setTo(value)}
        placeholder={chainType === 'evm' ? '0x...' : chainType === 'solana' ? 'Base58...' : 'BTC...'}
      />

      <TextField
        label={`提币数量（${selectedToken?.token_symbol || '代币'}）`}
        value={amount}
        onChange={(value) => setAmount(clampNumericInput(value))}
        type="text"
        placeholder={selectedToken?.is_native ? '例如 0.003' : '例如 12.5'}
      />
      <p className="text-xs text-muted-foreground">
        最大可提现余额：
        <span className="font-mono tabular-nums text-foreground">
          {balancesLoading ? '加载中...' : maxWithdrawBalance}
        </span>
        {selectedToken ? ` ${selectedToken.token_symbol}` : ''}
      </p>

      {!isAddressValid && to ? <p className="text-xs text-destructive">地址格式不合法</p> : null}
      {!isAmountPositive && amount ? <p className="text-xs text-destructive">提币数量必须大于 0</p> : null}

      <div className="text-xs text-muted-foreground">
        请填写人类可读数量，例如 0.003 ETH；后端会按代币精度转换为最小单位。
      </div>

      <Button
        onClick={() => {
          if (!canSubmit) return;
          void onSubmit({ chainType, chainId: selectedChainId, tokenId: Number(tokenId), to, amount });
        }}
        disabled={!canSubmit}
      >
        <Send className="mr-2 h-4 w-4" />
        提交提现
        <ArrowRight className="ml-2 h-4 w-4" />
      </Button>

      <p className="text-xs text-muted-foreground">
        当前网络 ID：{selectedChainId}
        {selectedToken ? ` / token_id：${selectedToken.id}` : ''}
      </p>
    </div>
  );
}
