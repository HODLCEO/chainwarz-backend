// server.js
const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");

// Node 18+ has global fetch. If your runtime is older, you must add node-fetch.
// Railway Node is usually 18+.
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// --- RPCs (use your working ones) ---
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const HYPEREVM_RPC = process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm";

// --- Contracts ---
const BASE_CONTRACT =
  process.env.BASE_CONTRACT || "0xB2B23e69b9d811D3D43AD473f90A171D18b19aab";
const HYPEREVM_CONTRACT =
  process.env.HYPEREVM_CONTRACT || "0x044A0B2D6eF67F5B82e51ec7229D84C0e83C8f02";

// --- Neynar ---
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY; // DO NOT hardcode in production
if (!NEYNAR_API_KEY) {
  console.warn("⚠️ NEYNAR_API_KEY is missing. Farcaster profiles will not resolve.");
}

const CONTRACT_ABI = ["event Strike(address indexed player, uint256 amount, uint256 timestamp)"];

const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
const hyperevmProvider = new ethers.JsonRpcProvider(HYPEREVM_RPC);

const baseContract = new ethers.Contract(BASE_CONTRACT, CONTRACT_ABI, baseProvider);
const hyperevmContract = new ethers.Contract(HYPEREVM_CONTRACT, CONTRACT_ABI, hyperevmProvider);

// Store per-address strike counts (raw)
const playerStats = {
  base: new Map(), // address -> { txCount, profile? }
  hyperevm: new Map(),
};

// Cache address->user profile lookups (so we don’t spam Neynar)
const addressProfileCache = new Map(); // lowerAddress -> { fid, username, displayName, pfpUrl, bio, custodyAddress, verifications }
const fidProfileCache = new Map(); // fid -> { fid, username, displayName, pfpUrl, bio, custodyAddress, verifications }

// ------------------------
// Neynar helpers
// ------------------------

function normalizeUserFromNeynar(u) {
  if (!u) return null;

  // Neynar returns fields like:
  // username, display_name, pfp_url, profile.bio.text, custody_address, verifications
  const username = u.username || null;
  const displayName = u.display_name || u.displayName || null;
  const pfpUrl = u.pfp_url || u.pfpUrl || null;
  const bio = u.profile?.bio?.text || u.bio || "";
  const fid = u.fid ?? null;
  const custodyAddress = (u.custody_address || u.custodyAddress || "").toLowerCase() || null;

  // verifications is typically an array of eth addresses (may include sol too depending endpoint)
  const verifications = Array.isArray(u.verifications)
    ? u.verifications.map((a) => String(a).toLowerCase())
    : [];

  return {
    fid,
    username,
    displayName,
    pfpUrl,
    bio,
    custodyAddress,
    verifications,
    warpcastUrl: username ? `https://warpcast.com/${username}` : null,
  };
}

async function fetchUserByFid(fid) {
  if (!NEYNAR_API_KEY) return null;
  if (!fid) return null;

  if (fidProfileCache.has(fid)) return fidProfileCache.get(fid);

  try {
    // Neynar: Fetch bulk users by fids (comma-separated)
    // Docs: https://docs.neynar.com/reference/fetch-bulk-users
    const url = `https://api.neynar.com/v2/farcaster/user/bulk?fids=${encodeURIComponent(
      String(fid)
    )}`;

    const resp = await fetch(url, {
      headers: {
        accept: "application/json",
        "x-api-key": NEYNAR_API_KEY,
      },
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    const user = data?.users?.[0];
    const normalized = normalizeUserFromNeynar(user);

    if (normalized) {
      fidProfileCache.set(fid, normalized);

      // Also backfill address cache for custody + verifications
      if (normalized.custodyAddress) addressProfileCache.set(normalized.custodyAddress, normalized);
      for (const v of normalized.verifications || []) addressProfileCache.set(v, normalized);
    }

    return normalized;
  } catch (e) {
    console.error("fetchUserByFid error:", e?.message || e);
    return null;
  }
}

async function fetchUsersByAddress(address) {
  if (!NEYNAR_API_KEY) return null;
  if (!address) return null;

  const a = String(address).toLowerCase();
  if (addressProfileCache.has(a)) return addressProfileCache.get(a);

  try {
    // Neynar: Fetch bulk users by address
    // Docs: https://docs.neynar.com/reference/fetch-bulk-users-by-eth-or-sol-address
    const url = `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${encodeURIComponent(
      a
    )}`;

    const resp = await fetch(url, {
      headers: {
        accept: "application/json",
        "x-api-key": NEYNAR_API_KEY,
      },
    });

    if (!resp.ok) return null;

    const data = await resp.json();

    // This endpoint returns a "users" list OR a mapping depending on version;
    // we safely handle either.
    const usersList = Array.isArray(data?.users)
      ? data.users
      : Array.isArray(data?.[a])
      ? data[a]
      : [];

    const best = usersList?.[0] || null;
    const normalized = normalizeUserFromNeynar(best);

    if (normalized) {
      addressProfileCache.set(a, normalized);
      fidProfileCache.set(normalized.fid, normalized);
    }

    return normalized;
  } catch (e) {
    console.error("fetchUsersByAddress error:", e?.message || e);
    return null;
  }
}

function fallbackProfileForAddress(address) {
  const a = String(address).toLowerCase();
  return {
    fid: null,
    username: `knight_${a.slice(2, 8)}`,
    displayName: "Knight",
    pfpUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${a}`,
    bio: "Chain warrior",
    custodyAddress: null,
    verifications: [],
    warpcastUrl: null,
  };
}

// ------------------------
// Polling (simple & stable)
// ------------------------

let lastBaseBlock = 0;
let lastHyperBlock = 0;

// These “scan windows” prevent RPC errors like “invalid block range” / “max block range”
const MAX_BLOCKS_PER_QUERY_BASE = 1500;
const MAX_BLOCKS_PER_QUERY_HYPER = 800; // hyper RPCs are often stricter

async function pollChain({
  chainKey,
  provider,
  contract,
  lastBlockRef,
  setLastBlockRef,
  maxRange,
}) {
  try {
    const head = await provider.getBlockNumber();

    if (!lastBlockRef.value) {
      // start near head, so we don't query giant historical ranges
      lastBlockRef.value = Math.max(0, head - 500);
      console.log(`[${chainKey}] polling from block ${lastBlockRef.value}`);
    }

    if (head <= lastBlockRef.value) return;

    // scan in chunks
    let from = lastBlockRef.value + 1;
    while (from <= head) {
      const to = Math.min(head, from + maxRange);

      const events = await contract.queryFilter("Strike", from, to);

      for (const ev of events) {
        const addr = String(ev.args.player).toLowerCase();
        const map = chainKey === "base" ? playerStats.base : playerStats.hyperevm;

        const current = map.get(addr) || { txCount: 0, profile: null };
        current.txCount += 1;

        // lazy profile lookup
        if (!current.profile) {
          const p = (await fetchUsersByAddress(addr)) || fallbackProfileForAddress(addr);
          current.profile = p;
        }

        map.set(addr, current);
      }

      lastBlockRef.value = to;
      setLastBlockRef(lastBlockRef.value);

      from = to + 1;
    }
  } catch (e) {
    const msg = e?.shortMessage || e?.message || String(e);
    console.error(`[${chainKey}] poll error:`, msg);
  }
}

const lastBaseBlockRef = { value: 0 };
const lastHyperBlockRef = { value: 0 };

function startPolling() {
  setInterval(() => {
    pollChain({
      chainKey: "base",
      provider: baseProvider,
      contract: baseContract,
      lastBlockRef: lastBaseBlockRef,
      setLastBlockRef: (v) => (lastBaseBlock = v),
      maxRange: MAX_BLOCKS_PER_QUERY_BASE,
    });
  }, 5000);

  setInterval(() => {
    pollChain({
      chainKey: "hyperevm",
      provider: hyperevmProvider,
      contract: hyperevmContract,
      lastBlockRef: lastHyperBlockRef,
      setLastBlockRef: (v) => (lastHyperBlock = v),
      maxRange: MAX_BLOCKS_PER_QUERY_HYPER,
    });
  }, 9000);

  // run once immediately
  pollChain({
    chainKey: "base",
    provider: baseProvider,
    contract: baseContract,
    lastBlockRef: lastBaseBlockRef,
    setLastBlockRef: (v) => (lastBaseBlock = v),
    maxRange: MAX_BLOCKS_PER_QUERY_BASE,
  });

  pollChain({
    chainKey: "hyperevm",
    provider: hyperevmProvider,
    contract: hyperevmContract,
    lastBlockRef: lastHyperBlockRef,
    setLastBlockRef: (v) => (lastHyperBlock = v),
    maxRange: MAX_BLOCKS_PER_QUERY_HYPER,
  });
}

// ------------------------
// Aggregation logic (FID)
// ------------------------
// This is the key: combine multiple wallets into one “player” row by fid.
// If fid is missing, we treat the address as its own player.

function sumStrikesForAddresses(chainMap, addresses) {
  let total = 0;
  for (const a of addresses) {
    const row = chainMap.get(String(a).toLowerCase());
    if (row?.txCount) total += row.txCount;
  }
  return total;
}

function buildLeaderboard(chainKey) {
  const chainMap = chainKey === "base" ? playerStats.base : playerStats.hyperevm;

  // Group: fid -> { profile, addresses[], txCount }
  // Also keep “address-only” entries where fid is null.
  const fidGroups = new Map();
  const addressOnly = [];

  for (const [address, data] of chainMap.entries()) {
    const profile = data.profile || fallbackProfileForAddress(address);
    const fid = profile?.fid ?? null;

    if (!fid) {
      addressOnly.push({
        address,
        username: profile.username,
        pfpUrl: profile.pfpUrl,
        txCount: data.txCount || 0,
        fid: null,
      });
      continue;
    }

    const existing = fidGroups.get(fid) || {
      fid,
      profile,
      addresses: new Set(),
      txCount: 0,
    };

    existing.addresses.add(address);
    fidGroups.set(fid, existing);
  }

  // Now expand each fid group to include custody + verifications from Neynar (if present)
  const merged = [];
  for (const g of fidGroups.values()) {
    const p = g.profile || {};
    const addrs = new Set(g.addresses);

    if (p.custodyAddress) addrs.add(p.custodyAddress);
    for (const v of p.verifications || []) addrs.add(v);

    const allAddresses = Array.from(addrs);
    const total = sumStrikesForAddresses(chainMap, allAddresses);

    merged.push({
      fid: g.fid,
      address: p.custodyAddress || allAddresses[0], // display anchor
      username: p.username || `fid_${g.fid}`,
      pfpUrl: p.pfpUrl || `https://api.dicebear.com/7.x/avataaars/svg?seed=${g.fid}`,
      txCount: total,
      displayName: p.displayName || null,
      warpcastUrl: p.warpcastUrl || null,
    });
  }

  // Combine fid merged + addressOnly, sort, rank
  const combined = [...merged, ...addressOnly]
    .sort((a, b) => (b.txCount || 0) - (a.txCount || 0))
    .slice(0, 50)
    .map((row, idx) => ({ ...row, rank: idx + 1 }));

  return combined;
}

// ------------------------
// Routes
// ------------------------

app.get("/api/leaderboard/:chain", (req, res) => {
  const chain = String(req.params.chain || "").toLowerCase();
  if (chain !== "base" && chain !== "hyperevm") return res.status(400).json({ error: "bad chain" });
  return res.json(buildLeaderboard(chain));
});

app.get("/api/profile/:address", async (req, res) => {
  const address = String(req.params.address || "").toLowerCase();

  const baseRow = playerStats.base.get(address);
  const hyperRow = playerStats.hyperevm.get(address);

  const profile =
    baseRow?.profile ||
    hyperRow?.profile ||
    (await fetchUsersByAddress(address)) ||
    fallbackProfileForAddress(address);

  res.json({
    ...profile,
    txCount: {
      base: baseRow?.txCount || 0,
      hyperevm: hyperRow?.txCount || 0,
    },
  });
});

// ✅ NEW: Always fetch “real Farcaster profile” by fid (fixes Farcaster-wallet identity)
app.get("/api/farcaster/user/:fid", async (req, res) => {
  const fid = Number(req.params.fid);
  if (!fid || Number.isNaN(fid)) return res.status(400).json({ error: "bad fid" });

  const user = (await fetchUserByFid(fid)) || null;
  if (!user) return res.status(404).json({ error: "not found" });

  return res.json(user);
});

app.get("/health", async (req, res) => {
  // helpful diagnostics
  let baseHead = null;
  let hyperHead = null;
  try {
    baseHead = await baseProvider.getBlockNumber();
  } catch {}
  try {
    hyperHead = await hyperevmProvider.getBlockNumber();
  } catch {}

  res.json({
    status: "ok",
    port: PORT,
    baseContract: BASE_CONTRACT,
    hyperevmContract: HYPEREVM_CONTRACT,
    base: {
      last: lastBaseBlockRef.value,
      head: baseHead,
      ok: true,
    },
    hyperevm: {
      last: lastHyperBlockRef.value,
      head: hyperHead,
      ok: true,
    },
    basePlayers: playerStats.base.size,
    hyperevmPlayers: playerStats.hyperevm.size,
  });
});

app.listen(PORT, () => {
  console.log(`ChainWarZ Backend listening on ${PORT}`);
  console.log(`Base RPC: ${BASE_RPC}`);
  console.log(`HyperEVM RPC: ${HYPEREVM_RPC}`);
  console.log(`Base contract: ${BASE_CONTRACT}`);
  console.log(`HyperEVM contract: ${HYPEREVM_CONTRACT}`);
  startPolling();
});
