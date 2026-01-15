// ChainWarZ Backend Server
// Run with: node server.js

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const PORT = 3001;
const BASE_RPC = 'https://base-mainnet.public.blastapi.io'; // More reliable RPC
const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';
const BASE_CONTRACT = '0xd4142119673975d18D49203702A73a6b6938A7D1';
const HYPEREVM_CONTRACT = '0x044A0B2D6eF67F5B82e51ec7229D84C0e83C8f02';

// IMPORTANT: Get your free API key from https://neynar.com
const NEYNAR_API_KEY = '307A6072-40FD-4110-A3D1-1720B70863D3';

// In-memory storage (use a real database in production)
const playerStats = {
  base: new Map(),
  hyperevm: new Map()
};

// Providers
const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
const hyperevmProvider = new ethers.JsonRpcProvider(HYPEREVM_RPC);

// Contract ABI - only the events we need
const CONTRACT_ABI = [
  "event Strike(address indexed player, uint256 amount, uint256 timestamp)"
];

// Initialize contracts
const baseContract = new ethers.Contract(BASE_CONTRACT, CONTRACT_ABI, baseProvider);
const hyperevmContract = new ethers.Contract(HYPEREVM_CONTRACT, CONTRACT_ABI, hyperevmProvider);

// Fetch Farcaster profile data
async function getFarcasterProfile(address) {
  try {
    if (NEYNAR_API_KEY === 'PASTE_YOUR_NEYNAR_API_KEY_HERE') {
      console.log('⚠️  Neynar API key not set - using default profile');
      return getDefaultProfile(address);
    }

    const response = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${address}`,
      {
        headers: {
          'accept': 'application/json',
          'api_key': NEYNAR_API_KEY
        }
      }
    );
    
    const data = await response.json();
    
    if (data[address]?.[0]) {
      const user = data[address][0];
      return {
        username: user.username,
        displayName: user.display_name,
        bio: user.profile.bio.text,
        pfpUrl: user.pfp_url,
        fid: user.fid
      };
    }
  } catch (error) {
    console.error('Error fetching Farcaster profile:', error);
  }
  
  return getDefaultProfile(address);
}

function getDefaultProfile(address) {
  return {
    username: 'knight_' + address.substring(2, 8),
    displayName: 'Knight',
    bio: 'Chain warrior',
    pfpUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${address}`,
    fid: null
  };
}

// Listen for Strike events on Base using polling
let lastBaseBlock = 0;

async function pollBase() {
  try {
    const currentBlock = await baseProvider.getBlockNumber();
    
    if (lastBaseBlock === 0) {
      lastBaseBlock = currentBlock - 10; // Only look back 10 blocks instead of 100
      console.log(`📊 Base starting from block ${lastBaseBlock}`);
    }
    
    if (currentBlock > lastBaseBlock) {
      console.log(`🔍 Checking Base blocks ${lastBaseBlock + 1} to ${currentBlock}`);
      
      const events = await baseContract.queryFilter(
        'Strike',
        lastBaseBlock + 1,
        currentBlock
      );
      
      console.log(`📝 Found ${events.length} Base events`);
      
      for (const event of events) {
        console.log(`⚔️  Base Strike from ${event.args.player}`);
        
        const playerAddress = event.args.player.toLowerCase();
        const current = playerStats.base.get(playerAddress) || { txCount: 0, profile: null };
        current.txCount++;
        
        if (!current.profile) {
          current.profile = await getFarcasterProfile(playerAddress);
        }
        
        playerStats.base.set(playerAddress, current);
      }
      
      lastBaseBlock = currentBlock;
    }
  } catch (error) {
    console.error('Error polling Base:', error.message);
  }
}

function listenToBase() {
  console.log('🛡️  Listening to Base contract (polling mode)...');
  
  // Poll every 5 seconds
  setInterval(pollBase, 5000);
  
  // Poll immediately
  pollBase();
}

// Listen for Strike events on HyperEVM using polling (filters not supported)
let lastHyperEVMBlock = 0;

async function pollHyperEVM() {
  try {
    const currentBlock = await hyperevmProvider.getBlockNumber();
    
    if (lastHyperEVMBlock === 0) {
      lastHyperEVMBlock = currentBlock - 100; // Start from 100 blocks ago
    }
    
    if (currentBlock > lastHyperEVMBlock) {
      const events = await hyperevmContract.queryFilter(
        'Strike',
        lastHyperEVMBlock + 1,
        currentBlock
      );
      
      for (const event of events) {
        console.log(`⚔️  HyperEVM Strike from ${event.args.player}`);
        
        const playerAddress = event.args.player.toLowerCase();
        const current = playerStats.hyperevm.get(playerAddress) || { txCount: 0, profile: null };
        current.txCount++;
        
        if (!current.profile) {
          current.profile = await getFarcasterProfile(playerAddress);
        }
        
        playerStats.hyperevm.set(playerAddress, current);
      }
      
      lastHyperEVMBlock = currentBlock;
    }
  } catch (error) {
    console.error('Error polling HyperEVM:', error.message);
  }
}

function listenToHyperEVM() {
  console.log('💚 Listening to HyperEVM contract (polling mode)...');
  
  // Poll every 10 seconds
  setInterval(pollHyperEVM, 10000);
  
  // Poll immediately
  pollHyperEVM();
}

// API Endpoints

// Get leaderboard
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

// Get player profile
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

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    players: playerStats.base.size + playerStats.hyperevm.size,
    baseStrikes: Array.from(playerStats.base.values()).reduce((sum, p) => sum + p.txCount, 0),
    hyperevmStrikes: Array.from(playerStats.hyperevm.values()).reduce((sum, p) => sum + p.txCount, 0)
  });
});

// Start server
app.listen(PORT, async () => {
  console.log(`🏰 ChainWarZ Backend running on http://localhost:${PORT}`);
  console.log(`🔗 Contract addresses:`);
  console.log(`   Base: ${BASE_CONTRACT}`);
  console.log(`   HyperEVM: ${HYPEREVM_CONTRACT}`);
  console.log('');
  
  // Start listening to new events
  listenToBase();
  listenToHyperEVM();
  
  console.log('');
  console.log('✅ Backend ready! Send some strikes to see them tracked!');
});