'use client';

import { useEffect, useMemo, useState } from 'react';
import { Coins, Plus, RefreshCw, ShieldAlert } from 'lucide-react';

import { useUserSession } from '@/lib/auth/user-session-context';
import { canAccessRiskControl } from '@/lib/auth/roles';
import { useAdminTokens, useCreateToken, useTokenOnboardingOptions } from '@/lib/hooks/use-wallet';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/ui/loading';
import { StatusBadge } from '@/components/ui/badge';
import { Surface } from '@/components/ui/surface';
import { TextField } from '@/components/ui/text-field';
import type { TokenOnboardingOption, TokenOnboardingType } from '@/types/api/wallet';

const TOKEN_TYPE_LABELS: Record<TokenOnboardingType, string> = {
  erc20: 'ERC20',
  'spl-token': 'SPL Token',
  'spl-token-2022': 'SPL Token 2022'
};

const SOLANA_MINT_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HUMAN_READABLE_AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;

function shortAddress(address?: string | null) {
  if (!address) return '--';
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function formatMinimalUnitAmount(value?: string | null, decimals = 0) {
  if (!value && value !== '0') return '--';
  const normalized = String(value);
  if (!/^\d+$/.test(normalized)) return normalized;
  if (Number(decimals) <= 0) return normalized;

  const padded = normalized.padStart(decimals + 1, '0');
  const integerPart = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '') || '0';
  const fractionPart = padded.slice(-decimals).replace(/0+$/, '');
  return fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
}

export default function TokensPage() {
  const { user } = useUserSession();
  const onboardingOptionsQuery = useTokenOnboardingOptions();
  const onboardingOptions = useMemo(() => onboardingOptionsQuery.data || [], [onboardingOptionsQuery.data]);
  const [selectedChainKey, setSelectedChainKey] = useState('');
  const [tokenType, setTokenType] = useState<TokenOnboardingType>('erc20');
  const [tokenAddress, setTokenAddress] = useState('');
  const [collectAmount, setCollectAmount] = useState('0');
  const [withdrawFee, setWithdrawFee] = useState('0');
  const [minWithdrawAmount, setMinWithdrawAmount] = useState('0');

  const selectedChain = useMemo<TokenOnboardingOption | undefined>(
    () => onboardingOptions.find((item) => `${item.chain_type}:${item.chain_id}` === selectedChainKey),
    [onboardingOptions, selectedChainKey]
  );
  const tokensQuery = useAdminTokens({
    chainType: selectedChain?.chain_type,
    chainId: selectedChain?.chain_id
  });
  const createToken = useCreateToken();
  const selectedChainTokens = useMemo(() => tokensQuery.data || [], [tokensQuery.data]);
  const amountFieldsValid = [collectAmount, withdrawFee, minWithdrawAmount].every((value) => HUMAN_READABLE_AMOUNT_PATTERN.test(value));
  const isEvm = selectedChain?.chain_type === 'evm';
  const addressLabel = isEvm ? '合约地址' : 'Mint 地址';
  const addressPlaceholder = isEvm ? '0x...' : 'Solana mint 地址';
  const trimmedTokenAddress = tokenAddress.trim();
  const addressValid = selectedChain
    ? isEvm
      ? /^0x[a-fA-F0-9]{40}$/.test(trimmedTokenAddress)
      : SOLANA_MINT_ADDRESS_PATTERN.test(trimmedTokenAddress)
    : false;
  const addressError = selectedChain && trimmedTokenAddress && !addressValid
    ? isEvm
      ? '请输入有效的 ERC20 合约地址'
      : '请输入有效的 Solana mint 地址'
    : undefined;
  const amountError = amountFieldsValid ? undefined : '金额只能填写非负数字，例如 0、1、1.5';

  useEffect(() => {
    if (!selectedChainKey && onboardingOptions.length > 0) {
      const first = onboardingOptions[0];
      setSelectedChainKey(`${first.chain_type}:${first.chain_id}`);
      setTokenType(first.token_types[0] || 'erc20');
    }
  }, [onboardingOptions, selectedChainKey]);

  useEffect(() => {
    if (!selectedChain) return;
    if (!selectedChain.token_types.includes(tokenType)) {
      setTokenType(selectedChain.token_types[0] || 'erc20');
    }
  }, [selectedChain, tokenType]);

  if (!canAccessRiskControl(user)) {
    return (
      <Surface title="无权访问" subtitle="只有客服、支持、风控和管理员可以管理代币配置。">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldAlert className="h-4 w-4" />
          当前账户没有代币管理权限。
        </div>
      </Surface>
    );
  }

  const submitDisabled =
    createToken.isPending ||
    !selectedChain ||
    !addressValid ||
    !amountFieldsValid;

  return (
    <div className="grid gap-4">
      <Surface title="代币管理" subtitle="添加代币后，充值扫描、提现和归集会按 tokens 配置识别该代币。">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-md border border-border bg-muted/30">
              <Coins className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div className="font-medium">多链代币配置</div>
              <p className="text-sm text-muted-foreground">合约或 mint 地址会按链维度去重，新增后扫描服务需重新加载或重启。</p>
            </div>
          </div>
          <Button variant="outline" className="gap-2" onClick={() => void tokensQuery.refetch()} disabled={tokensQuery.isFetching}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
        </div>
      </Surface>

      <Surface title="新增代币" subtitle="金额字段填写人类可读数值，例如 1.5；后端会按链上 decimals 转成最小单位入库。">
        {onboardingOptionsQuery.isLoading ? (
          <LoadingState label="加载链选项..." />
        ) : onboardingOptionsQuery.isError ? (
          <ErrorState message={onboardingOptionsQuery.error.message} />
        ) : onboardingOptions.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无可新增代币的链</div>
        ) : (
          <>
        <div className="grid gap-3 lg:grid-cols-[0.8fr,1.6fr]">
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">网络</span>
            <select
              className="h-11 rounded-lg border border-border bg-background px-3 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
              value={selectedChainKey}
              onChange={(event) => {
                const nextChainKey = event.target.value;
                const nextChain = onboardingOptions.find((item) => `${item.chain_type}:${item.chain_id}` === nextChainKey);
                setSelectedChainKey(nextChainKey);
                setTokenType(nextChain?.token_types[0] || 'erc20');
                setTokenAddress('');
              }}
            >
              {onboardingOptions.map((item) => (
                <option key={`${item.chain_type}:${item.chain_id}`} value={`${item.chain_type}:${item.chain_id}`}>
                  {item.name} ({item.chain_id})
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">代币类型</span>
            <select
              className="h-11 rounded-lg border border-border bg-background px-3 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
              value={tokenType}
              onChange={(event) => setTokenType(event.target.value as TokenOnboardingType)}
            >
              {(selectedChain?.token_types || []).map((item) => (
                <option key={item} value={item}>{TOKEN_TYPE_LABELS[item]}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3">
          <TextField
            label={addressLabel}
            value={tokenAddress}
            onChange={setTokenAddress}
            placeholder={addressPlaceholder}
            error={addressError}
          />
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <TextField label="归集阈值" value={collectAmount} onChange={setCollectAmount} error={amountError} />
          <TextField label="提现手续费" value={withdrawFee} onChange={setWithdrawFee} error={amountError} />
          <TextField label="最小提现额" value={minWithdrawAmount} onChange={setMinWithdrawAmount} error={amountError} />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          代币符号、名称和精度都由后端链读；Solana mint 必须带链上 metadata，金额字段会按链上 decimals 转成最小单位入库。
        </p>
        <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center">
          <Button
            className="gap-2"
            disabled={submitDisabled}
            onClick={() => {
              if (!selectedChain) return;
              createToken.mutate(
                {
                  chain_type: selectedChain.chain_type,
                  chain_id: selectedChain.chain_id,
                  token_type: tokenType,
                  token_address: trimmedTokenAddress,
                  collect_amount: collectAmount,
                  withdraw_fee: withdrawFee,
                  min_withdraw_amount: minWithdrawAmount
                },
                {
                  onSuccess: () => {
                    setTokenAddress('');
                    setCollectAmount('0');
                    setWithdrawFee('0');
                    setMinWithdrawAmount('0');
                  }
                }
              );
            }}
          >
            <Plus className="h-4 w-4" />
            添加代币
          </Button>
          {createToken.isSuccess ? (
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge label="已新增" tone="success" />
              <span className="text-sm text-muted-foreground">
                {createToken.data.token_symbol} / {createToken.data.token_name || createToken.data.token_symbol} / decimals {createToken.data.decimals}
              </span>
            </div>
          ) : null}
        </div>
        {createToken.isError ? <div className="mt-3"><ErrorState message={createToken.error.message} /></div> : null}
          </>
        )}
      </Surface>

      <Surface title="已配置代币" subtitle={`当前网络 ${selectedChain?.name || '--'}，共 ${selectedChainTokens.length} 个配置`}>
        {tokensQuery.isLoading ? (
          <LoadingState label="加载代币配置..." />
        ) : tokensQuery.isError ? (
          <ErrorState message={tokensQuery.error.message} />
        ) : selectedChainTokens.length === 0 ? (
          <div className="text-sm text-muted-foreground">当前网络暂无代币配置</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="pb-2 pr-4 font-medium">代币</th>
                  <th className="pb-2 pr-4 font-medium">类型</th>
                  <th className="pb-2 pr-4 font-medium">{isEvm ? '合约' : 'Mint'}</th>
                  <th className="pb-2 pr-4 font-medium">精度</th>
                  <th className="pb-2 pr-4 font-medium">归集阈值</th>
                  <th className="pb-2 pr-4 font-medium">提现手续费</th>
                  <th className="pb-2 pr-4 font-medium">最小提现</th>
                  <th className="pb-2 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {selectedChainTokens.map((item) => (
                  <tr key={item.id} className="border-t border-border/50">
                    <td className="py-3 pr-4">
                      <div className="font-medium">{item.token_symbol}</div>
                      <div className="text-xs text-muted-foreground">{item.token_name || '--'}</div>
                    </td>
                    <td className="py-3 pr-4">{item.is_native ? 'native' : item.token_type || 'erc20'}</td>
                    <td className="py-3 pr-4 font-mono text-xs" title={item.token_address || undefined}>{shortAddress(item.token_address)}</td>
                    <td className="py-3 pr-4 font-mono tabular-nums">{item.decimals}</td>
                    <td className="py-3 pr-4 font-mono tabular-nums">{formatMinimalUnitAmount(item.collect_amount, item.decimals)}</td>
                    <td className="py-3 pr-4 font-mono tabular-nums">{formatMinimalUnitAmount(item.withdraw_fee, item.decimals)}</td>
                    <td className="py-3 pr-4 font-mono tabular-nums">{formatMinimalUnitAmount(item.min_withdraw_amount, item.decimals)}</td>
                    <td className="py-3">
                      <StatusBadge label={Number(item.status) === 1 ? '启用' : '禁用'} tone={Number(item.status) === 1 ? 'success' : 'default'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>
    </div>
  );
}
