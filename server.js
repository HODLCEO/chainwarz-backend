// server.js — FULL FILE REWRITE (fix Railway "failed to respond")

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Railway provides PORT. Do not override it with a different number.
const PORT = Number(process.env.PORT || 3001);

// --- FAST routes (respond instantly) ---
app.get('/', (req, res) => {
  res.status(200).send('ok');
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    port: PORT,
    baseContract: process.env.BASE_CONTRACT || '0xB2B23e69b9d811D3D43AD473f90A171D18b19aab',
    hyperevmContract: process.env.HYPEREVM_CONTRACT || '0x044A0B2D6eF67F5B82e51ec7229D84C0e83C8f02',
  });
});

// --- Config ---
const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const HYPEREVM_RPC = process.env.HYPEREVM_RPC || 'https://rpc.hyperliquid.xyz/evm';

const BASE_CONTRACT =
  process.env.BASE_CONTRACT || '0xB2B23e69b9d811D3D43AD473f90A171D18b19aab';

const HYPEREVM_CONTRACT =
  process.env.HYPEREVM_CONTRACT || '0x044A0B2D6eF67F5B82e51ec7229D84C0e83C8f02';

const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY || '';

const MAX_LOG_BLOCK_RANGE = 900;

const playerStats = {
  base: new Map(),
  hyperevm: new Map(),
};

const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
const hyperevmProvider = new ethers.JsonRpcProvider(HYPEREVM_RPC);

const CONTRACT_ABI = [
  'event Strike(address indexed player, uint256 amount, uint256 timestamp)'
];

const baseContract = new ethers.Contract(BASE_CONTRACT, CONTRACT_ABI, baseProvider);
const hyperevmContract = new ethers.Contract(HYPEREVM_CONTRACT, CONTRACT_ABI, hyperevmProvider);

async function getFarcasterProfile(address) {
  if (!NEYNAR_API_KEY) {
    return {
      username: 'knight_' + address.substring(2, 8),
      displayName: 'Knight',
      bio: 'Chain warrior',
      pfpUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${address}`,
      fid: null,
    };
  }

  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${address}`,
      { headers: { accept: 'application/json', api_key: NEYNAR_API_KEY } }
    );

    const data = await response.json();
    if (data[address]?.[0]) {
      const user = data[address][0];
      return {
        username: user.username,
        displayName: user.display_name,
        bio: user.profile?.bio?.text || '',
        pfpUrl: user.pfp_url,
        fid: user.fid,
      };
    }
  } catch (e) {
    console.error('Neynar profile fetch error:', e?.message || e);
  }

  return {
    username: 'knight_' + address.substring(2, 8),
    displayName: 'Knight',
    bio: 'Chain warrior',
    pfpUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${address}`,
    fid: null,
  };
}

async function pollChunked({ chainKey, provider, contract, lastBlockRef, lookback, intervalMs }) {
  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();

      if (lastBlockRef.value === 0) {
        lastBlockRef.value = Math.max(0, currentBlock - lookback);
        console.log(`[${chainKey}] polling from block ${lastBlockRef.value}`);
      }

      while (lastBlockRef.value < currentBlock) {
        const fromBlock = lastBlockRef.value + 1;
        const toBlock = Math.min(currentBlock, fromBlock + MAX_LOG_BLOCK_RANGE);

        const events = await contract.queryFilter('Strike', fromBlock, toBlock);

        for (const event of events) {
          const player = event.args.player.toLowerCase();
          const existing = playerStats[chainKey].get(player) || { txCount: 0, profile: null };
          existing.txCount++;

          if (!existing.profile) {
            existing.profile = await getFarcasterProfile(player);
          }

          playerStats[chainKey].set(player, existing);
        }

        lastBlockRef.value = toBlock;
        await new Promise((r) => setTimeout(r, 150));
      }
    } catch (e) {
      console.error(`Error polling ${chainKey}:`, e?.message || e);
    }
  }, intervalMs);
}

// Leaderboard endpoints (unchanged)
app.get('/api/leaderboard/:chain', async (req, res) => {
  const key = req.params.chain === 'base' ? 'base' : 'hyperevm';
  const stats = playerStats[key];

  const leaderboard = Array.from(stats.entries())
    .map(([address, data]) => ({
      address,
      username: data.profile?.username || 'knight_' + address.substring(2, 8),
      pfpUrl: data.profile?.pfpUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${address}`,
      txCount: data.txCount,
    }))
    .sort((a, b) => b.txCount - a.txCount)
    .slice(0, 25)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  res.json(leaderboard);
});

app.get('/api/profile/:address', async (req, res) => {
  const addr = req.params.address.toLowerCase();

  const baseStats = playerStats.base.get(addr);
  const hyperStats = playerStats.hyperevm.get(addr);

  const profile = baseStats?.profile || hyperStats?.profile || (await getFarcasterProfile(addr));

  res.json({
    ...profile,
    txCount: {
      base: baseStats?.txCount || 0,
      hyperevm: hyperStats?.txCount || 0,
    },
  });
});

// ✅ Important: bind to 0.0.0.0 so Railway can reach it
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`ChainWarZ Backend listening on ${PORT}`);
  console.log(`Base RPC: ${BASE_RPC}`);
  console.log(`HyperEVM RPC: ${HYPEREVM_RPC}`);
  console.log(`Base contract: ${BASE_CONTRACT}`);
  console.log(`HyperEVM contract: ${HYPEREVM_CONTRACT}`);

  // Start pollers AFTER server is reachable
  const lastBase = { value: 0 };
  const lastHyper = { value: 0 };

  pollChunked({
    chainKey: 'base',
    provider: baseProvider,
    contract: baseContract,
    lastBlockRef: lastBase,
    lookback: 500,
    intervalMs: 5000,
  });

  pollChunked({
    chainKey: 'hyperevm',
    provider: hyperevmProvider,
    contract: hyperevmContract,
    lastBlockRef: lastHyper,
    lookback: 900,
    intervalMs: 8000,
  });
});

// (Optional) keep-alive tuning
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
