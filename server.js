// server.js
// ChainWarZ Backend
// - Polls Strike events on Base + HyperEVM
// - Leaderboards aggregated by Farcaster user (FID) by resolving wallet -> user via Neynar bulk-by-address
// - Still works for wallets with no Farcaster identity (falls back to address-based entry)

const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");

// Fetch for Node compatibility
const fetchFn =
  globalThis.fetch ||
  ((...args) => import("node-fetch").then(({ default: f }) => f(...args)));

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// RPC + Contracts (use env vars if present)
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const HYPEREVM_RPC = process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm";

const BASE_CONTRACT =
  process.env.BASE_CONTRACT || "0xB2B23e69b9d811D3D43AD473f90A171D18b19aab";
const HYPEREVM_CONTRACT =
  process.env.HYPEREVM_CONTRACT || "0x044A0B2D6eF67F5B82e51ec7229D84C0e83C8f02";

// Neynar (IMPORTANT: header is x-api-key) :contentReference[oaicite:2]{index=2}
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY || "";
const NEYNAR_BASE = "https://api.neynar.com";

const CONTRACT_ABI = ["event Strike(address indexed player, uint256 amount, uint256 timestamp)"];

const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
const hyperevmProvider = new ethers.JsonRpcProvider(HYPEREVM_RPC);

const baseContract = new ethers.Contract(BASE_CONTRACT, CONTRACT_ABI, baseProvider);
const hyperevmContract = new ethers.Contract(HYPEREVM_CONTRACT, CONTRACT_ABI, hyperevmProvider);

// In-memory stats (address -> { txCount })
const playerStats = {
  base: new Map(),
  hyperevm: new Map(),
};

// Small caches to reduce Neynar calls
const addressToProfileCache = new Map(); // addressLower -> { profile, ts }
const CACHE_TTL_MS = 10 * 60 * 1000;

// Helper
function now() {
  return Date.now();
}
function normAddr(a) {
  return (a || "").toLowerCase();
}
function shortAddr(a) {
  if (!a) return "";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
function dicebear(address) {
  return `https://api.dicebear.com/7.x/avataaars/svg?seed=${address}`;
}

// ---------- Neynar Resolve (bulk-by-address) ----------
async function neynarBulkUsersByAddress(addresses) {
  // addresses: array of 0x...
  if (!NEYNAR_API_KEY) return [];

  const unique = Array.from(new Set(addresses.map(normAddr))).filter(Boolean);
  if (!unique.length) return [];

  // Neynar endpoint expects comma-separated addresses param :contentReference[oaicite:3]{index=3}
  const url = `${NEYNAR_BASE}/v2/farcaster/user/bulk-by-address?addresses=${encodeURIComponent(
    unique.join(",")
  )}`;

  const res = await fetchFn(url, {
    headers: {
      accept: "application/json",
      "x-api-key": NEYNAR_API_KEY, // correct header :contentReference[oaicite:4]{index=4}
    },
  });

  if (!res.ok) return [];

  const data = await res.json();

  // Defensive parsing: Neynar responses vary by SDK/version. We accept:
  // - { users: [...] }
  // - [...]
  // - { result: { users: [...] } }
  const users =
    (Array.isArray(data) && data) ||
    data?.users ||
    data?.result?.users ||
    data?.result ||
    [];

  return Array.isArray(users) ? users : [];
}

function profileFromNeynarUser(u) {
  if (!u) return null;

  const username = u.username ? `@${u.username}` : null;
  const displayName = u.display_name || u.displayName || u.username || "Knight";
  const pfpUrl = u.pfp_url || u.pfpUrl || null;

  const bio =
    u?.profile?.bio?.text ||
    u?.profile?.bio ||
    "";

  const fid = u.fid || null;
  const warpcastUrl = u.username ? `https://warpcast.com/${u.username}` : null;

  return {
    fid,
    username,
    displayName,
    bio,
    pfpUrl,
    warpcastUrl,
  };
}

function buildAddressToUserMap(users) {
  // We map addresses -> user, prioritizing custody_address over verified addresses
  // because custody is unique while verified can overlap.
  const map = new Map(); // addrLower -> { user, priority }
  for (const u of users) {
    const custody = normAddr(u.custody_address || u.custodyAddress);
    if (custody) {
      map.set(custody, { user: u, priority: 2 });
    }

    const verifications =
      (Array.isArray(u.verifications) && u.verifications) ||
      (Array.isArray(u.verified_addresses?.eth_addresses) && u.verified_addresses.eth_addresses) ||
      (Array.isArray(u.verifiedAddresses) && u.verifiedAddresses) ||
      [];

    for (const v of verifications) {
      const addr = normAddr(v);
      if (!addr) continue;
      const existing = map.get(addr);
      if (!existing || existing.priority < 2) {
        // only overwrite if we don't have custody mapping already
        map.set(addr, { user: u, priority: 1 });
      }
    }
  }
  return map;
}

async function getProfileForAddress(address) {
  const a = normAddr(address);
  if (!a) return null;

  const cached = addressToProfileCache.get(a);
  if (cached && now() - cached.ts < CACHE_TTL_MS) return cached.profile;

  const users = await neynarBulkUsersByAddress([a]);
  const addrMap = buildAddressToUserMap(users);

  const match = addrMap.get(a)?.user || users[0] || null;
  const profile = profileFromNeynarUser(match) || {
    fid: null,
    username: `@knight_${a.substring(2, 8)}`,
    displayName: "Knight",
    bio: "Chain warrior",
    pfpUrl: dicebear(a),
    warpcastUrl: null,
  };

  // Ensure pfp fallback
  if (!profile.pfpUrl) profile.pfpUrl = dicebear(a);

  addressToProfileCache.set(a, { profile, ts: now() });
  return profile;
}

// ---------- Polling ----------
let lastBaseBlock = 0;
let lastHyperBlock = 0;

// Keep log windows small to avoid RPC errors
const BASE_POLL_INTERVAL_MS = 5000;
const HYPER_POLL_INTERVAL_MS = 9000;

const BASE_MAX_BLOCK_RANGE = 500;     // small chunking
const HYPER_MAX_BLOCK_RANGE = 300;    // hyper RPC tends to rate limit

async function pollChain({ name, provider, contract, lastBlockRef, statsMap, maxRange }) {
  try {
    const head = await provider.getBlockNumber();

    if (lastBlockRef.value === 0) {
      lastBlockRef.value = head - 50;
      if (lastBlockRef.value < 0) lastBlockRef.value = 0;
      console.log(`[${name}] polling from block ${lastBlockRef.value}`);
    }

    // Walk in chunks to avoid "invalid block range" / provider limits
    let from = lastBlockRef.value + 1;

    while (from <= head) {
      const to = Math.min(from + maxRange, head);

      const events = await contract.queryFilter("Strike", from, to);

      for (const ev of events) {
        const player = normAddr(ev?.args?.player);
        if (!player) continue;
        const current = statsMap.get(player) || { txCount: 0 };
        current.txCount += 1;
        statsMap.set(player, current);
      }

      lastBlockRef.value = to;
      from = to + 1;
    }
  } catch (e) {
    console.error(`[${name}] poll error:`, e?.message || e);
  }
}

function startPolling() {
  const baseRef = { value: lastBaseBlock };
  const hyperRef = { value: lastHyperBlock };

  setInterval(() => pollChain({
    name: "base",
    provider: baseProvider,
    contract: baseContract,
    lastBlockRef: baseRef,
    statsMap: playerStats.base,
    maxRange: BASE_MAX_BLOCK_RANGE,
  }), BASE_POLL_INTERVAL_MS);

  setInterval(() => pollChain({
    name: "hyperevm",
    provider: hyperevmProvider,
    contract: hyperevmContract,
    lastBlockRef: hyperRef,
    statsMap: playerStats.hyperevm,
    maxRange: HYPER_MAX_BLOCK_RANGE,
  }), HYPER_POLL_INTERVAL_MS);

  // run once immediately
  pollChain({
    name: "base",
    provider: baseProvider,
    contract: baseContract,
    lastBlockRef: baseRef,
    statsMap: playerStats.base,
    maxRange: BASE_MAX_BLOCK_RANGE,
  });
  pollChain({
    name: "hyperevm",
    provider: hyperevmProvider,
    contract: hyperevmContract,
    lastBlockRef: hyperRef,
    statsMap: playerStats.hyperevm,
    maxRange: HYPER_MAX_BLOCK_RANGE,
  });
}

// ---------- Leaderboard (Aggregated by FID) ----------
async function buildAggregatedLeaderboard(chainKey) {
  const stats = chainKey === "base" ? playerStats.base : playerStats.hyperevm;

  // Convert map to list
  const raw = Array.from(stats.entries()).map(([address, v]) => ({
    address,
    txCount: v.txCount || 0,
  }));

  // Sort by txCount, keep top N (keeps Neynar query reasonable)
  raw.sort((a, b) => b.txCount - a.txCount);
  const top = raw.slice(0, 200);

  const addresses = top.map((x) => x.address);

  // Resolve Farcaster users for these addresses in one call :contentReference[oaicite:5]{index=5}
  const users = await neynarBulkUsersByAddress(addresses);
  const addrMap = buildAddressToUserMap(users);

  // Group by fid if found, else by address
  const grouped = new Map(); // key -> aggregateRow

  for (const entry of top) {
    const addr = normAddr(entry.address);
    const user = addrMap.get(addr)?.user || null;

    const profile = profileFromNeynarUser(user);

    const key = profile?.fid ? `fid:${profile.fid}` : `addr:${addr}`;

    const existing = grouped.get(key) || {
      fid: profile?.fid || null,
      // representative address (keep one for display)
      address: addr,
      addresses: new Set(),
      username: profile?.username || `@knight_${addr.substring(2, 8)}`,
      displayName: profile?.displayName || "Knight",
      pfpUrl: profile?.pfpUrl || dicebear(addr),
      warpcastUrl: profile?.warpcastUrl || null,
      txCount: 0,
    };

    existing.txCount += entry.txCount;
    existing.addresses.add(addr);

    // Prefer a better pfp if we get one later
    if ((!existing.pfpUrl || existing.pfpUrl.includes("dicebear")) && profile?.pfpUrl) {
      existing.pfpUrl = profile.pfpUrl;
    }
    // Prefer a better username if we get one later
    if (existing.username?.startsWith("@knight_") && profile?.username) {
      existing.username = profile.username;
    }
    // Prefer display name
    if (existing.displayName === "Knight" && profile?.displayName) {
      existing.displayName = profile.displayName;
    }

    grouped.set(key, existing);
  }

  // Finalize
  const result = Array.from(grouped.values()).map((x) => ({
    ...x,
    addresses: Array.from(x.addresses),
  }));

  result.sort((a, b) => b.txCount - a.txCount);

  return result.slice(0, 25).map((row, idx) => ({
    rank: idx + 1,
    address: row.address,
    addresses: row.addresses,
    fid: row.fid,
    username: row.username,
    displayName: row.displayName,
    pfpUrl: row.pfpUrl,
    txCount: row.txCount,
    warpcastUrl: row.warpcastUrl,
  }));
}

// ---------- Routes ----------
app.get("/api/leaderboard/:chain", async (req, res) => {
  const chain = (req.params.chain || "").toLowerCase();
  if (chain !== "base" && chain !== "hyperevm") {
    return res.status(400).json({ error: "invalid chain" });
  }

  try {
    const lb = await buildAggregatedLeaderboard(chain);
    res.json(lb);
  } catch (e) {
    console.error("leaderboard error:", e?.message || e);
    res.json([]);
  }
});

app.get("/api/profile/:address", async (req, res) => {
  const addr = normAddr(req.params.address);
  if (!addr) return res.status(400).json({ error: "invalid address" });

  const baseStats = playerStats.base.get(addr);
  const hypStats = playerStats.hyperevm.get(addr);

  const profile = await getProfileForAddress(addr);

  res.json({
    ...profile,
    txCount: {
      base: baseStats?.txCount || 0,
      hyperevm: hypStats?.txCount || 0,
    },
  });
});

app.get("/health", async (req, res) => {
  res.json({
    status: "ok",
    port: Number(PORT),
    baseContract: BASE_CONTRACT,
    hyperevmContract: HYPEREVM_CONTRACT,
    basePlayers: playerStats.base.size,
    hyperevmPlayers: playerStats.hyperevm.size,
  });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`ChainWarZ Backend listening on ${PORT}`);
  console.log(`Base RPC: ${BASE_RPC}`);
  console.log(`HyperEVM RPC: ${HYPEREVM_RPC}`);
  console.log(`Base contract: ${BASE_CONTRACT}`);
  console.log(`HyperEVM contract: ${HYPEREVM_CONTRACT}`);
  startPolling();
});
