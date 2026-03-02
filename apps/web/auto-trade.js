const $ = (id) => document.getElementById(id);

const STORAGE_KEY = 'web4pay_lobster_trades_v1';
const HISTORY_LIMIT = 20;
const BSC_MAINNET_ID = 56;
const PANCAKE_ROUTER = '0x10ed43c718714eb63d5aa57b78b54704e256024e';

const TOKEN_LIST = {
  USDT: {
    symbol: 'USDT',
    address: '0x55d398326f99059ff775485246999027b3197955',
    decimals: 18,
  },
  BUSD: {
    symbol: 'BUSD',
    address: '0xe9e7cea3dedca5984780bafc599bd69add087d56e',
    decimals: 18,
  },
  CAKE: {
    symbol: 'CAKE',
    address: '0x0e09fabb73bd3ade0a17bc2205fe4a9aa6a1',
    decimals: 18,
  },
  XVS: {
    symbol: 'XVS',
    address: '0xcf6bb5389c92bdda8a3747ddb454cb7a64626c63d',
    decimals: 18,
  },
  WBNB: {
    symbol: 'WBNB',
    address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    decimals: 18,
  },
};

const PAIR_INPUT = {
  USDT_WBNB: { in: 'USDT', out: 'WBNB' },
  BUSD_WBNB: { in: 'BUSD', out: 'WBNB' },
  CAKE_WBNB: { in: 'CAKE', out: 'WBNB' },
  XVS_WBNB: { in: 'XVS', out: 'WBNB' },
};

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
];

const state = {
  provider: null,
  signer: null,
  account: '',
  chainId: 0,
  router: null,
  running: false,
  intervalId: null,
  position: null,
  history: [],
  runNonce: 0,
  monitorInProgress: false,
  lastError: '',
};

const DEFAULTS = {
  takeProfit: 5,
  stopLoss: 2,
  intervalSec: 12,
  slippageBps: 80,
};

function toast(message) {
  const badge = $('tradeStatus');
  if (badge) badge.textContent = message;
  appendLog(message);
}

function appendLog(message) {
  const el = $('log');
  if (!el) return;
  const now = new Date().toLocaleTimeString();
  el.textContent = `[${now}] ${message}\n${el.textContent}`;
  el.textContent = el.textContent.slice(0, 16000);
}

function setField(id, value) {
  const el = $(id);
  if (!el) return;
  el.value = value;
}

function getField(id, fallback = '') {
  const el = $(id);
  return el ? String(el.value || '') : fallback;
}

function parseNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBigInt(v) {
  try {
    return window.ethers.getBigInt(v);
  } catch {
    return BigInt(v);
  }
}

function ensureEthersLoaded() {
  if (!window.ethers || !window.ethers.Contract) {
    throw new Error('ethers.js 未加载成功');
  }
}

function getToken(symbol) {
  const token = TOKEN_LIST[symbol];
  if (!token) throw new Error(`未知代币：${symbol}`);
  return token;
}

function getPairConfig() {
  const key =
    typeof window !== 'undefined' && window.document
      ? document.getElementById('pairSymbol')?.value || 'USDT_WBNB'
      : 'USDT_WBNB';
  const cfg = PAIR_INPUT[key] || PAIR_INPUT.USDT_WBNB;
  return cfg;
}

function getInputAmountWei(tokenIn) {
  const amount = parseNum(getField('amountIn', '10'), 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('买入金额必须大于 0');
  }
  return window.ethers.parseUnits(String(amount), tokenIn.decimals);
}

function parsePercent(value, fallback) {
  const v = parseNum(value, fallback);
  if (v <= 0 || v >= 1000) throw new Error('百分比参数不合理（应 >0 且 <1000）');
  return v;
}

function normalizeAddress(addr) {
  return String(addr || '').toLowerCase();
}

function nowPlusMinutes(mins = 10) {
  return Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(mins * 60));
}

function computePnlPercent(entryValue, currentValue) {
  if (!Number.isFinite(entryValue) || entryValue <= 0) return 0;
  return Number((((currentValue - entryValue) / entryValue) * 100).toFixed(4));
}

function toNumber(token, amountWei) {
  return Number(window.ethers.formatUnits(amountWei, token.decimals));
}

function renderHistory() {
  const list = $('tradeHistory');
  if (!list) return;
  list.textContent = '';
  if (!state.history.length) {
    list.textContent = '暂无记录';
    return;
  }

  state.history.forEach((item) => {
    const line = document.createElement('div');
    line.className = 'line';
    const status = item.status === 'closed' ? '✅' : item.status === 'stopped' ? '⏹️' : '🧪';
    line.innerHTML = `<div><strong>${status} ${item.pair || '-'} ${item.entryMode || ''}</strong> <small>(${new Date(item.createdAt).toLocaleString()})</small></div>` +
      `<div class="meta">PnL: ${Number(item.pnlPct || 0).toFixed(4)}% · entryTx: ${item.entryTx || '-'} · exitTx: ${item.exitTx || '-'} · reason: ${item.exitReason || '-'} </div>`;
    list.appendChild(line);
  });
}

function persistHistory() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.history.slice(0, HISTORY_LIMIT)));
}

function getHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function pushHistory(item) {
  const row = {
    ...item,
    createdAt: item.createdAt || new Date().toISOString(),
  };
  state.history.unshift(row);
  state.history = state.history.slice(0, HISTORY_LIMIT);
  persistHistory();
  renderHistory();
}

function setRunningState(running) {
  state.running = running;
  const startBtn = $('startBot');
  const stopBtn = $('stopBot');
  if (startBtn) startBtn.disabled = running;
  if (stopBtn) stopBtn.disabled = !running;
}

function updatePhase(text) {
  setField('phase', text);
}

function showSpeech(text) {
  const el = $('lobsterSpeech');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  el.classList.add('show');
  window.setTimeout(() => {
    el.classList.remove('show');
    el.hidden = true;
  }, 1400);
}

function setPositionUi(position) {
  if (position) {
    setField('holdingAmount', position.holdingDisplay || '0');
    setField('entryRate', position.entryRate ? `${position.entryRate} ${position.out} / ${position.in}` : '');
    setField('unrealizedPnl', position.unrealizedPnl != null ? `${position.unrealizedPnl}%` : '0');
  }
}

async function getSignerAndProvider(forceConnect = false) {
  ensureEthersLoaded();
  if (!window.ethereum || typeof window.ethereum.request !== 'function') {
    throw new Error('未检测到可用钱包（MetaMask / 兼容钱包）');
  }

  const provider = new window.ethers.BrowserProvider(window.ethereum);
  if (forceConnect) {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!Array.isArray(accounts) || !accounts[0]) {
      throw new Error('钱包未返回账户');
    }
  }

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  if (chainId !== BSC_MAINNET_ID) {
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${BSC_MAINNET_ID.toString(16)}` }],
      });
    } catch (err) {
      if (err?.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: `0x${BSC_MAINNET_ID.toString(16)}`,
            chainName: 'BNB Smart Chain Mainnet',
            rpcUrls: ['https://bsc-dataseed.binance.org/'],
            nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
            blockExplorerUrls: ['https://bscscan.com/'],
          }],
        });
      } else {
        const msg = err?.message || 'Unknown wallet error';
        throw new Error(`钱包网络切换失败：${msg}`);
      }
    }
    const afterNetwork = await provider.getNetwork();
    if (Number(afterNetwork.chainId) !== BSC_MAINNET_ID) {
      throw new Error(`请切换到 BSC 主网后重试（当前 chainId=${afterNetwork.chainId}）`);
    }
  }

  const signer = await provider.getSigner();
  const account = await signer.getAddress();
  const router = new window.ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, signer);

  state.provider = provider;
  state.signer = signer;
  state.account = account;
  state.chainId = BSC_MAINNET_ID;
  state.router = router;

  return { provider, signer, account, router };
}

async function ensureBscWalletConnected() {
  await getSignerAndProvider(true);
  const conn = $('connBadge');
  if (conn) conn.textContent = `已连接：${state.account.slice(0, 6)}...${state.account.slice(-4)}`;
  setField('walletAddress', state.account);
  await refreshBnbBalance();
  toast(`钱包已连接：${state.account}`);
}

async function refreshBnbBalance() {
  if (!state.provider || !state.account) return;
  const balWei = await state.provider.getBalance(state.account);
  setField('bnbBalance', `${window.ethers.formatEther(balWei)}`);
}

function getTokenContract(token) {
  if (!state.signer) throw new Error('未连接钱包');
  return new window.ethers.Contract(token.address, ERC20_ABI, state.signer);
}

async function quoteExactIn(tokenIn, tokenOut, amountInWei) {
  if (!state.router) throw new Error('路由未就绪');
  const amounts = await state.router.getAmountsOut(amountInWei, [tokenIn.address, tokenOut.address]);
  return amounts[1];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(label, fn, retries = 2) {
  let lastErr = null;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i >= retries) break;
      const backoff = 500 * Math.pow(1.8, i);
      appendLog(`${label} 重试 ${i + 1}/${retries}: ${err.message}`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

async function getTokenBalance(token, owner) {
  const c = getTokenContract(token);
  return await c.balanceOf(owner);
}

async function ensureAllowance(tokenIn, amountInWei) {
  const contract = getTokenContract(tokenIn);
  const allowance = await contract.allowance(state.account, PANCAKE_ROUTER);
  if (allowance >= amountInWei) return;

  appendLog(`Approve ${tokenIn.symbol}: ${window.ethers.formatUnits(amountInWei, tokenIn.decimals)}`);
  const tx = await contract.approve(PANCAKE_ROUTER, amountInWei);
  const rec = await tx.wait();
  appendLog(`Approve 已确认，区块Gas: ${rec?.gasUsed ? rec.gasUsed.toString() : 'n/a'}，tx=${tx.hash}`);
}

async function preflight(cfg, amountInWei) {
  const tokenIn = getToken(cfg.in);
  const tokenOut = getToken(cfg.out);

  const [balInWei, balanceBnb, quoteWei] = await Promise.all([
    getTokenBalance(tokenIn, state.account),
    state.provider.getBalance(state.account),
    quoteExactIn(tokenIn, tokenOut, amountInWei),
  ]);

  const amountInNum = toNumber(tokenIn, amountInWei);
  const balInNum = toNumber(tokenIn, balInWei);
  if (balInWei < amountInWei) {
    throw new Error(`${tokenIn.symbol} 余额不足：${balInNum} < ${amountInNum}`);
  }
  if (quoteWei <= 0n) {
    throw new Error('报价失败：当前池子返回 0 输出');
  }

  const minBnb = window.ethers.parseEther('0.0006');
  if (balanceBnb < minBnb) {
    throw new Error('BNB 余额过低，请预留 Gas 费用（建议 >= 0.0006 BNB）');
  }

  return {
    quoteWei,
    inBalance: balInWei,
  };
}

async function executeBuy(cfg, amountInWei, slippageBps) {
  const tokenIn = getToken(cfg.in);
  const tokenOut = getToken(cfg.out);

  const quoteOut = await quoteExactIn(tokenIn, tokenOut, amountInWei);
  const _slippage = BigInt(Math.min(999, Math.max(1, Math.floor(Number(slippageBps) || 80))));
  const minOut = quoteOut - (quoteOut * _slippage) / 10000n;

  await ensureAllowance(tokenIn, amountInWei);

  const tx = await state.router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
    amountInWei,
    minOut,
    [tokenIn.address, tokenOut.address],
    state.account,
    nowPlusMinutes(10),
    {
      gasLimit: 450000,
      gasPrice: (await state.provider.getFeeData()).gasPrice,
    },
  );

  const rec = await tx.wait();
  return {
    txHash: tx.hash,
    gasUsed: rec?.gasUsed?.toString() || '',
    quoteOut,
  };
}

async function executeSell(cfg, amountToSellWei, slippageBps) {
  const tokenIn = getToken(cfg.in);
  const tokenOut = getToken(cfg.out);

  const quoteIn = await quoteExactIn(tokenOut, tokenIn, amountToSellWei);
  const _slippage = BigInt(Math.min(999, Math.max(1, Math.floor(Number(slippageBps) || 80))));
  const minIn = quoteIn - (quoteIn * _slippage) / 10000n;

  const tx = await state.router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
    amountToSellWei,
    minIn,
    [tokenOut.address, tokenIn.address],
    state.account,
    nowPlusMinutes(10),
    {
      gasLimit: 450000,
      gasPrice: (await state.provider.getFeeData()).gasPrice,
    },
  );
  const rec = await tx.wait();
  return {
    txHash: tx.hash,
    gasUsed: rec?.gasUsed?.toString() || '',
  };
}

async function calcHoldingValue(tokenOut, amountWei, cfg) {
  const tokenIn = getToken(cfg.in);
  const oneOut = window.ethers.parseUnits('1', tokenOut.decimals);
  const inPerOut = await quoteExactIn(tokenOut, tokenIn, oneOut);
  const holding = Number(window.ethers.formatUnits(amountWei, tokenOut.decimals));
  const inPerOutNum = Number(window.ethers.formatUnits(inPerOut, tokenIn.decimals));
  return holding * inPerOutNum;
}

async function closePositionIfNeeded(cfg, cfgs) {
  const tokenOut = getToken(cfg.out);
  const { takeProfitPct, stopLossPct, slippageBps, auto } = cfgs;

  if (!state.position || state.position.status !== 'open' || state.monitorInProgress) return;

  state.monitorInProgress = true;
  try {
    const holdingWei = await getTokenBalance(tokenOut, state.account);
    const holdingNum = toNumber(tokenOut, holdingWei);
    setField('holdingAmount', holdingNum.toString());

    if (holdingWei <= 0n) {
      state.position.status = 'stopped';
      state.position.exitReason = 'empty_holding';
      state.position.pnlPct = Number(state.position.entryValueInput ? state.position.entryValueInput : 0);
      pushHistory(state.position);
      stopStrategy(true);
      return;
    }

    const currentValue = await calcHoldingValue(tokenOut, holdingWei, cfg);
    const pnl = computePnlPercent(state.position.entryValueInput, currentValue);
    state.position.unrealizedPnl = Number(pnl.toFixed(4));
    setField('unrealizedPnl', `${state.position.unrealizedPnl}%`);
    setField('livePrice', `${currentValue.toFixed(6)} ${cfg.in}`);

    if (pnl >= takeProfitPct) {
      appendLog(`触发止盈 ${pnl}% >= ${takeProfitPct}%`);
      showSpeech('到达止盈，执行平仓');
      await closePosition(cfg, slippageBps, true);
      return;
    }
    if (pnl <= -Math.abs(stopLossPct)) {
      appendLog(`触发止损 ${pnl}% <= -${Math.abs(stopLossPct)}%`);
      showSpeech('到达止损，执行平仓');
      await closePosition(cfg, slippageBps, true);
      return;
    }
  } finally {
    state.monitorInProgress = false;
  }
}

async function closePosition(cfg, slippageBps, auto = true) {
  if (!state.position || state.position.status !== 'open') return;

  const tokenOut = getToken(cfg.out);
  const amountToSellWei = await getTokenBalance(tokenOut, state.account);

  if (amountToSellWei <= 0n) {
    state.position.status = 'closed';
    state.position.exitTx = '';
    state.position.exitReason = 'zero_balance';
    state.position.pnlPct = state.position.unrealizedPnl || 0;
    pushHistory(state.position);
    stopStrategy();
    return;
  }

  const currentValue = await calcHoldingValue(tokenOut, amountToSellWei, cfg);
  const sell = await withRetry('平仓', () => executeSell(cfg, amountToSellWei, slippageBps));

  const pnl = computePnlPercent(state.position.entryValueInput, currentValue);

  state.position.exitTx = sell.txHash;
  state.position.exitValue = currentValue;
  state.position.exitReason = auto ? 'auto' : 'manual';
  state.position.pnlPct = Number(pnl.toFixed(4));
  state.position.status = 'closed';
  state.position.closedAt = new Date().toISOString();

  appendLog(`平仓成功 tx=${sell.txHash} pnl=${state.position.pnlPct}% gas=${sell.gasUsed}`);
  pushHistory(state.position);
  setPositionUi(state.position);
  updatePhase('closed');
  stopStrategy();
}

function stopStrategy(errorMode = false) {
  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }

  setRunningState(false);
  const shouldPersist = errorMode && state.position && state.position.status === 'open';
  if (shouldPersist) {
    state.position.status = 'stopped';
    state.position.stoppedAt = new Date().toISOString();
    state.position.pnlPct = Number((state.position.unrealizedPnl || 0).toFixed(4));
    pushHistory(state.position);
  }

  if (state.position && state.position.status === 'closed') {
    setPositionUi(state.position);
  }
  updatePhase('已停止');
}

async function startStrategy() {
  try {
    await ensureBscWalletConnected();
  } catch (err) {
    appendLog(`连接失败: ${err.message}`);
    toast('连接失败，不能启动');
    return;
  }

  if (state.running) return;

  const cfg = getPairConfig();
  const tokenIn = getToken(cfg.in);
  const tokenOut = getToken(cfg.out);

  const amountInWei = getInputAmountWei(tokenIn);
  const amountInDisplay = parseNum(getField('amountIn'), 10);
  const takeProfitPct = parsePercent(getField('takeProfit'), DEFAULTS.takeProfit);
  const stopLossPct = parsePercent(getField('stopLoss'), DEFAULTS.stopLoss);
  const intervalSec = Math.max(4, parseInt(getField('intervalSec'), 10) || DEFAULTS.intervalSec);
  const slippageBps = Math.max(5, Math.min(1000, parseInt(getField('slippageBps'), 10) || DEFAULTS.slippageBps));

  const runId = ++state.runNonce;

  setRunningState(true);
  updatePhase('准备买入');
  appendLog(`单边策略启动：${tokenIn.symbol}/${tokenOut.symbol}，TP=${takeProfitPct}%，SL=${stopLossPct}%`);
  showSpeech('开始执行单边策略');

  try {
    await withRetry('预检', () => preflight(cfg, amountInWei));

    const outPreview = await quoteExactIn(tokenIn, tokenOut, amountInWei);
    const entryRate = toNumber(tokenOut, outPreview) / amountInDisplay;
    setField('entryRate', `${entryRate.toFixed(8)} ${tokenOut.symbol}/${tokenIn.symbol}`);

    const buy = await withRetry('买入', () => executeBuy(cfg, amountInWei, slippageBps));

    const afterBalanceOut = await getTokenBalance(tokenOut, state.account);
    const initialHolding = toNumber(tokenOut, afterBalanceOut);

    state.position = {
      pair: `${tokenIn.symbol}/${tokenOut.symbol}`,
      in: tokenIn.symbol,
      out: tokenOut.symbol,
      entryTx: buy.txHash,
      entryMode: 'single-direction-long',
      status: 'open',
      entryRate: entryRate.toFixed(8),
      entryValueInput: amountInDisplay,
      entryAmount: amountInDisplay,
      holding: initialHolding,
      holdingDisplay: String(initialHolding),
      entryTime: new Date().toISOString(),
      runId,
    };

    updatePhase('已买入，等待触发');
    setField('unrealizedPnl', '0%');
    setField('livePrice', '...');
    appendLog(`买入已上链: ${buy.txHash}，本次消耗 gas=${buy.gasUsed || 'n/a'}`);

    state.intervalId = window.setInterval(() => {
      closePositionIfNeeded(cfg, {
        takeProfitPct,
        stopLossPct,
        slippageBps,
      }).catch((err) => {
        state.lastError = err.message;
        appendLog(`监控失败: ${err.message}`);
      });
    }, intervalSec * 1000);

    // 快速首轮执行，减少初始空窗
    await closePositionIfNeeded(cfg, {
      takeProfitPct,
      stopLossPct,
      slippageBps,
    });
  } catch (err) {
    toast(`启动失败: ${err.message}`);
    appendLog(`启动失败: ${err.message}`);
    stopStrategy(true);
  }
}

function stopButtonHandler() {
  if (!state.position || state.position.status !== 'open') {
    stopStrategy();
    return;
  }
  appendLog('手动停止：保留当前仓位，停止监听');
  stopStrategy(true);
}

function clearLog() {
  const el = $('log');
  if (el) el.textContent = '';
}

function copyLog() {
  const el = $('log');
  if (!el) return;
  if (!navigator?.clipboard?.writeText) {
    toast('当前浏览器不支持复制');
    return;
  }
  navigator.clipboard.writeText(el.textContent || '').then(() => {
    toast('日志已复制');
  }).catch(() => {
    toast('复制失败');
  });
}

function disconnectWallet() {
  state.provider = null;
  state.signer = null;
  state.account = '';
  state.router = null;
  state.chainId = 0;
  setField('walletAddress', '');
  setField('bnbBalance', '');
  const conn = $('connBadge');
  if (conn) conn.textContent = '未连接';
  toast('钱包断开成功（刷新可重新连接）');
}

function init() {
  state.history = getHistory();
  renderHistory();

  $('connectWallet')?.addEventListener('click', ensureBscWalletConnected);
  $('disconnectWallet')?.addEventListener('click', disconnectWallet);
  $('startBot')?.addEventListener('click', startStrategy);
  $('stopBot')?.addEventListener('click', stopButtonHandler);
  $('clearLog')?.addEventListener('click', clearLog);
  $('copyLog')?.addEventListener('click', copyLog);

  setField('amountIn', getField('amountIn', '10') || '10');
  setField('takeProfit', getField('takeProfit', String(DEFAULTS.takeProfit)) || String(DEFAULTS.takeProfit));
  setField('stopLoss', getField('stopLoss', String(DEFAULTS.stopLoss)) || String(DEFAULTS.stopLoss));
  setField('intervalSec', getField('intervalSec', String(DEFAULTS.intervalSec)) || String(DEFAULTS.intervalSec));
  setField('slippageBps', getField('slippageBps', String(DEFAULTS.slippageBps)) || String(DEFAULTS.slippageBps));

  setRunningState(false);
  updatePhase('待启动');
  toast('自动交易页面就绪（单向长线：买入后等待 TP/SL）');
}

window.addEventListener('DOMContentLoaded', init);
