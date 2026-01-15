// server.js (Backend) — FULL FILE REWRITE

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// RPCs (you can override these in Railway variables later if you want)
const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const HYPEREVM_RPC = process.env.HYPEREVM_RPC || 'https://rpc.hyperliquid.xyz/evm';

// Contracts
const BASE_CONTRACT = process.env.BASE_CONTRACT || '0xB2B23e69b9d811D3D43AD473f90A171D18b19aab';
const HYPEREVM_CONTRACT = process.env.HYPEREVM_CONTRACT || '0xDddED87c1f1487495E8aa47c9B43FEf4c5153054';

// Neynar
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY || '';

// Default strike values (only used if we cannot detect a recent successful Strike event)
const DEFAULT_STRIKE_WEI = {
  base: '1337000000000',        // 0.000001337 ETH
  hyperevm: '133700000000000',  // 0.0001337 HYPE (fallback only)
};

// Chain metadata for the frontend (used for switch/add chain UX)
const CHAIN_META = {
  base: {
    key: 'base',
    chainIdDecimal: 8453,
    chainIdHex: '0x2105',
    chainName: 'Base',
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorerUrls: ['https://basescan.org'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    contractAddress: BASE_CONTRACT,
  },
  hyperevm: {
    key: 'hyperevm',
    chainIdDecimal: 999,
    chainIdHex: '0x3e7',
    chainName: 'HyperEVM',
    rpcUrls: ['https://rpc.hyperliquid.xyz/evm'],
    blockExplorerUrls: ['https://explorer.hyperliquid.xyz'],
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    contractAddress: HYPEREVM_CONTRACT,
  }
};

const playerStats = {
  base: new Map(),
  hyperevm: new Map()
};

const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
const hyperevmProvider = new ethers.JsonRpcProvider(HYPEREVM_RPC);

// We only need the event ABI (already in your project)
const CONTRACT_ABI = [
  'event Strike(address indexed player, uint256 amount, uint256 timestamp)'
];

const baseContract = new ethers.Contract(BASE_CONTRACT, CONTRACT_ABI, baseProvider);
const hyperevmContract = new ethers.Contract(HYPEREVM_CONTRACT, CONTRACT_ABI, hyperevmProvider);

// We will keep the most recently observed *successful* strike amounts here:
const latestStrikeWei = {
  base: null,      // string
  hyperevm: null,  // string
};

function format18(weiString) {
  try {
    const v = ethers.formatEther(BigInt(weiString));
    // Keep it clean for UI — trim trailing zeros
    if (v.includes('.')) return v.replace(/\.?0+$/, '');
    return v;
  } catch {
    return null;
  }
}

async function getFarcasterProfile(address) {
  // If you didn’t set NEYNAR_API_KEY in Railway, we still work, but return a fallback identity.
  if (!NEYNAR_API_KEY) {
    return {
      username: 'knight_' + address.substring(2, 8),
      displayName: 'Knight',
      bio: 'Chain warrior',
      pfpUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${address}`,
      fid: null
    };
  }

  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${address}`,
      {
        headers: {
          accept: 'application/json',
          api_key: NEYNAR_API_KEY
        }
      }
    );

    const data = await response.json();

    if (data[address]?.[0]) {
      const user = data[address][0];
      return {
        username: user.username,
        displayName: user.display_name,
        bio: user.profile?.bio?.text || '',
        pfpUrl: user.pfp_url,
        fid: user.fid
      };
    }
  } catch (error) {
    console.error('Error fetching Farcaster profile:', error?.message || error);
  }

  return {
    username: 'knight_' + address.substring(2, 8),
    displayName: 'Knight',
    bio: 'Chain warrior',
    pfpUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${address}`,
    fid: null
  };
}

/**
 * Seed latestStrikeWei by scanning recent history for Strike events.
 * We scan in small block windows so RPC providers don’t choke.
 */
async function seedLatestStrikeWeiFor(chainKey, provider, contract) {
  try {
    const current = await provider.getBlockNumber();
    const windowSize = 5000;
    const maxWindows = 30; // 150k blocks max scan

    for (let i = 0; i < maxWindows; i++) {
      const toBlock = current - (i * windowSize);
      const fromBlock = Math.max(0, toBlock - windowSize + 1);
      const events = await contract.queryFilter('Strike', fromBlock, toBlock);

      if (events && events.length) {
        const last = events[events.length - 1];
        const amt = last.args?.amount;
        if (amt != null) {
          latestStrikeWei[chainKey] = amt.toString();
          console.log(`[config] Seeded ${chainKey} strikeWei = ${latestStrikeWei[chainKey]}`);
          return;
        }
      }
    }

    console.log(`[config] No Strike events found during seed scan for ${chainKey}`);
  } catch (e) {
    console.error(`[config] Seed scan failed for ${chainKey}:`, e?.message || e);
  }
}

/**
 * Pollers keep leaderboard updated AND keep latestStrikeWei fresh when new Strikes happen.
 */
let lastBaseBlock = 0;
async function pollBase() {
  try {
    const currentBlock = await baseProvider.getBlockNumber();

    if (lastBaseBlock === 0) {
      // Start slightly behind so we pick up recent activity
      lastBaseBlock = Math.max(0, currentBlock - 500);
      console.log(`Base polling from block ${lastBaseBlock}`);
    }

    if (currentBlock > lastBaseBlock) {
      const events = await baseContract.queryFilter('Strike', lastBaseBlock + 1, currentBlock);

      for (const event of events) {
        const playerAddress = event.args.player.toLowerCase();
        const current = playerStats.base.get(playerAddress) || { txCount: 0, profile: null };
        current.txCount++;

        // Update latest strike amount from real successful events
        if (event.args.amount != null) {
          latestStrikeWei.base = event.args.amount.toString();
        }

        if (!current.profile) {
          current.profile = await getFarcasterProfile(playerAddress);
        }

        playerStats.base.set(playerAddress, current);
      }

      lastBaseBlock = currentBlock;
    }
  } catch (error) {
    console.error('Error polling Base:', error?.message || error);
  }
}

let lastHyperEVMBlock = 0;
async function pollHyperEVM() {
  try {
    const currentBlock = await hyperevmProvider.getBlockNumber();

    if (lastHyperEVMBlock === 0) {
      lastHyperEVMBlock = Math.max(0, currentBlock - 1000);
      console.log(`HyperEVM polling from block ${lastHyperEVMBlock}`);
    }

    if (currentBlock > lastHyperEVMBlock) {
      const events = await hyperevmContract.queryFilter('Strike', lastHyperEVMBlock + 1, currentBlock);

      for (const event of events) {
        const playerAddress = event.args.player.toLowerCase();
        const current = playerStats.hyperevm.get(playerAddress) || { txCount: 0, profile: null };
        current.txCount++;

        // Update latest strike amount from real successful events
        if (event.args.amount != null) {
          latestStrikeWei.hyperevm = event.args.amount.toString();
        }

        if (!current.profile) {
          current.profile = await getFarcasterProfile(playerAddress);
        }

        playerStats.hyperevm.set(playerAddress, current);
      }

      lastHyperEVMBlock = currentBlock;
    }
  } catch (error) {
    console.error('Error polling HyperEVM:', error?.message || error);
  }
}

function listenToBase() {
  setInterval(pollBase, 5000);
  pollBase();
}

function listenToHyperEVM() {
  setInterval(pollHyperEVM, 10000);
  pollHyperEVM();
}

/**
 * NEW: Config endpoint — frontend calls this to get the REAL strike amounts.
 * This keeps strike amounts correct even if contracts change.
 */
app.get('/api/config', async (req, res) => {
  const baseWei = latestStrikeWei.base || DEFAULT_STRIKE_WEI.base;
  const hyperWei = latestStrikeWei.hyperevm || DEFAULT_STRIKE_WEI.hyperevm;

  const baseFmt = format18(baseWei);
  const hyperFmt = format18(hyperWei);

  res.json({
    base: {
      ...CHAIN_META.base,
      strikeWei: baseWei,
      strikeAmount: baseFmt ? `${baseFmt} ${CHAIN_META.base.nativeCurrency.symbol}` : null,
    },
    hyperevm: {
      ...CHAIN_META.hyperevm,
      strikeWei: hyperWei,
      strikeAmount: hyperFmt ? `${hyperFmt} ${CHAIN_META.hyperevm.nativeCurrency.symbol}` : null,
    }
  });
});

app.get('/api/leaderboard/:chain', async (req, res) => {
  const { chain } = req.params;
  const stats = chain === 'base' ? playerStats.base : playerStats.hyperevm;

  const leaderboard = Array.from(stats.entries())
    .map(([address, data]) => ({
      address,
      username: data.profile?.username || 'knight_' + address.substring(2, 8),
      pfpUrl: data.profile?.pfpUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${address}`,
      txCount: data.txCount
    }))
    .sort((a, b) => b.txCount - a.txCount)
    .slice(0, 25)
    .map((player, idx) => ({
      ...player,
      rank: idx + 1
    }));

  res.json(leaderboard);
});

app.get('/api/profile/:address', async (req, res) => {
  const { address } = req.params;
  const lowerAddress = address.toLowerCase();

  let profile = null;
  const baseStats = playerStats.base.get(lowerAddress);
  const hyperevmStats = playerStats.hyperevm.get(lowerAddress);

  if (baseStats?.profile || hyperevmStats?.profile) {
    profile = baseStats?.profile || hyperevmStats?.profile;
  } else {
    profile = await getFarcasterProfile(lowerAddress);
  }

  res.json({
    ...profile,
    txCount: {
      base: baseStats?.txCount || 0,
      hyperevm: hyperevmStats?.txCount || 0
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    players: playerStats.base.size + playerStats.hyperevm.size,
    baseStrikes: Array.from(playerStats.base.values()).reduce((sum, p) => sum + p.txCount, 0),
    hyperevmStrikes: Array.from(playerStats.hyperevm.values()).reduce((sum, p) => sum + p.txCount, 0),
    latestStrikeWei
  });
});

app.listen(PORT, async () => {
  console.log(`ChainWarZ Backend running on port ${PORT}`);
  console.log(`Base contract: ${BASE_CONTRACT}`);
  console.log(`HyperEVM contract: ${HYPEREVM_CONTRACT}`);

  // Seed strikeWei so frontend can immediately send correct amounts
  await seedLatestStrikeWeiFor('base', baseProvider, baseContract);
  await seedLatestStrikeWeiFor('hyperevm', hyperevmProvider, hyperevmContract);

  listenToBase();
  listenToHyperEVM();

  console.log('Backend ready!');
});
