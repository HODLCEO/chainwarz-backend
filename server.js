// server.js — FULL FILE REWRITE (fix HyperEVM log range + correct contract watching)

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// RPCs
const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const HYPEREVM_RPC = process.env.HYPEREVM_RPC || 'https://rpc.hyperliquid.xyz/evm';

// Contracts (IMPORTANT: update these in Railway env vars too)
const BASE_CONTRACT =
  process.env.BASE_CONTRACT || '0xB2B23e69b9d811D3D43AD473f90A171D18b19aab';

// ✅ NEW HyperEVM contract default matches what you requested
const HYPEREVM_CONTRACT =
  process.env.HYPEREVM_CONTRACT || '0x044A0B2D6eF67F5B82e51ec7229D84C0e83C8f02';

// Neynar (optional)
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY || '';

// Polling limits
// HyperEVM RPC enforces max 1000 blocks for eth_getLogs.
// We use 900 to stay safely under.
const MAX_LOG_BLOCK_RANGE = 900;

// In-memory stats
const playerStats = {
  base: new Map(),
  hyperevm: new Map()
};

const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
const hyperevmProvider = new ethers.JsonRpcProvider(HYPEREVM_RPC);

// Only need Strike event ABI
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
      fid: null
    };
  }

  try {
    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${address}`,
      {
        headers: { accept: 'application/json', api_key: NEYNAR_API_KEY }
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

// ---- Generic chunked poller (prevents "query exceeds max block range 1000") ----
async function pollChain({
  chainKey,
  provider,
  contract,
  lastBlockRef,
  startLookbackBlocks,
  intervalMs
}) {
  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();

      // Initialize last polled block
      if (lastBlockRef.value === 0) {
        lastBlockRef.value = Math.max(0, currentBlock - startLookbackBlocks);
        console.log(`[${chainKey}] polling from block ${lastBlockRef.value}`);
      }

      // If we're behind, catch up in MAX_LOG_BLOCK_RANGE chunks
      while (lastBlockRef.value < currentBlock) {
        const fromBlock = lastBlockRef.value + 1;
        const toBlock = Math.min(currentBlock, fromBlock + MAX_LOG_BLOCK_RANGE);

        const events = await contract.queryFilter('Strike', fromBlock, toBlock);

        for (const event of events) {
          const playerAddress = event.args.player.toLowerCase();
          const current = playerStats[chainKey].get(playerAddress) || { txCount: 0, profile: null };
          current.txCount++;

          if (!current.profile) {
            current.profile = await getFarcasterProfile(playerAddress);
          }

          playerStats[chainKey].set(playerAddress, current);
        }

        lastBlockRef.value = toBlock;

        // If the chain is moving fast, avoid hammering the RPC
        await new Promise((r) => setTimeout(r, 150));
      }
    } catch (error) {
      console.error(`Error polling ${chainKey}:`, error?.message || error);
    }
  }, intervalMs);
}

// ---- Start polling ----
const lastBaseBlock = { value: 0 };
const lastHyperBlock = { value: 0 };

pollChain({
  chainKey: 'base',
  provider: baseProvider,
  contract: baseContract,
  lastBlockRef: lastBaseBlock,
  startLookbackBlocks: 500,
  intervalMs: 5000
});

pollChain({
  chainKey: 'hyperevm',
  provider: hyperevmProvider,
  contract: hyperevmContract,
  lastBlockRef: lastHyperBlock,
  startLookbackBlocks: 900, // important: keep within limits
  intervalMs: 8000
});

// ---- API endpoints ----
app.get('/api/leaderboard/:chain', async (req, res) => {
  const { chain } = req.params;
  const key = chain === 'base' ? 'base' : 'hyperevm';

  const stats = playerStats[key];

  const leaderboard = Array.from(stats.entries())
    .map(([address, data]) => ({
      address,
      username: data.profile?.username || 'knight_' + address.substring(2, 8),
      pfpUrl: data.profile?.pfpUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${address}`,
      txCount: data.txCount
    }))
    .sort((a, b) => b.txCount - a.txCount)
    .slice(0, 25)
    .map((player, idx) => ({ ...player, rank: idx + 1 }));

  res.json(leaderboard);
});

app.get('/api/profile/:address', async (req, res) => {
  const lower = req.params.address.toLowerCase();

  const baseStats = playerStats.base.get(lower);
  const hyperStats = playerStats.hyperevm.get(lower);

  const profile = baseStats?.profile || hyperStats?.profile || (await getFarcasterProfile(lower));

  res.json({
    ...profile,
    txCount: {
      base: baseStats?.txCount || 0,
      hyperevm: hyperStats?.txCount || 0
    }
  });
});

app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    baseContract: BASE_CONTRACT,
    hyperevmContract: HYPEREVM_CONTRACT,
    basePlayers: playerStats.base.size,
    hyperevmPlayers: playerStats.hyperevm.size
  });
});

app.listen(PORT, () => {
  console.log(`ChainWarZ Backend running on port ${PORT}`);
  console.log(`Base RPC: ${BASE_RPC}`);
  console.log(`HyperEVM RPC: ${HYPEREVM_RPC}`);
  console.log(`Base contract: ${BASE_CONTRACT}`);
  console.log(`HyperEVM contract: ${HYPEREVM_CONTRACT}`);
});
