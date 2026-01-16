// server.js
// ChainWarZ backend: polls strike logs, aggregates per-address AND per-farcaster-user (FID).
// Option A: keep Hyperliquid RPC, avoid rate limits by scanning small block windows + backoff.

const express = require("express");
const cors = require("cors");
const ethers = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

/** ============ CONFIG ============ */
const PORT = Number(process.env.PORT || 8080);

// RPCs (Option A: keep your current HyperEVM RPC)
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const HYPEREVM_RPC = process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm";

// Contracts
const BASE_CONTRACT =
  (process.env.BASE_CONTRACT || "0xB2B23e69b9d811D3D43AD473f90A171D18b19aab").toLowerCase();
const HYPEREVM_CONTRACT =
  (process.env.HYPEREVM_CONTRACT || "0x044A0B2D6eF67F5B82e51ec7229D84C0e83C8f02").toLowerCase();

// Strike event topic0 (from your logs screenshots)
const STRIKE_TOPIC0 =
  (process.env.STRIKE_TOPIC0 ||
    "0x0fa711b8ab6041b70f72ba6c16b2d0764ed34ca7c987d5c536a978e7d80c7d00").toLowerCase();

// Start blocks (set these in Railway Variables for full history)
const BASE_START_BLOCK = process.env.BASE_START_BLOCK ? Number(process.env.BASE_START_BLOCK) : null;
const HYPEREVM_START_BLOCK = process.env.HYPEREVM_START_BLOCK ? Number(process.env.HYPEREVM_START_BLOCK) : null;

// Polling windows (keep under provider limits)
const BASE_MAX_RANGE = Number(process.env.BASE_MAX_RANGE || 900); // < 1000 safe
const HYPEREVM_MAX_RANGE = Number(process.env.HYPEREVM_MAX_RANGE || 300); // smaller to reduce rate limits

// Poll intervals + backoff
const BASE_POLL_MS = Number(process.env.BASE_POLL_MS || 6000);
const HYPEREVM_POLL_MS = Number(process.env.HYPEREVM_POLL_MS || 9000);
const RATE_LIMIT_BACKOFF_MS = Number(process.env.RATE_LIMIT_BACKOFF_MS || 45000);

/** ============ NEYNAR ============ */
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY || "";
const NEYNAR_BASE = "https://api.neynar.com/v2/farcaster";

// By FIDs (returns pfp/bio/verifications etc)
async function neynarUserByFid(fid) {
  if (!NEYNAR_API_KEY) return null;
  const url = `${NEYNAR_BASE}/user/bulk?fids=${encodeURIComponent(fid)}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "x-api-key": NEYNAR_API_KEY },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const user = Array.isArray(data?.users) ? data.users[0] : null;
  if (!user) return null;

  const username = user.username || "";
  const displayName = user.display_name || user.displayName || "";
  const pfpUrl = user.pfp_url || user.pfpUrl || "";
  const bio =
    user?.profile?.bio?.text ||
    user?.profile?.bio ||
    user?.bio ||
    "";

  const custodyAddress = (user.custody_address || user.custodyAddress || "").toLowerCase();

  // verifications can appear in multiple shapes depending on Neynar response
  const verificationsRaw =
    user.verifications ||
    user?.verified_addresses?.eth_addresses ||
    user?.verified_addresses?.ethAddresses ||
    [];

  const verifications = Array.isArray(verificationsRaw)
    ? verificationsRaw.map((a) => String(a).toLowerCase())
    : [];

  // Farcaster renamed domains are moving around; safest is to build from username
  const farcasterUrl = username ? `https://farcaster.xyz/${username}` : null;

  return {
    fid: Number(user.fid),
    username,
    displayName,
    pfpUrl,
    bio,
    custodyAddress,
    verifications,
    farcasterUrl,
    // keep old field for compatibility
    warpcastUrl: username ? `https://warpcast.com/${username}` : null,
  };
}

// Bulk by address (NOTE: a verified address can map to multiple users, so we only accept unique mappings)
async function neynarByAddress(addresses) {
  if (!NEYNAR_API_KEY) return {};
  const addrList = addresses.map((a) => a.toLowerCase()).join(",");
  const url = `${NEYNAR_BASE}/user/bulk-by-address?addresses=${encodeURIComponent(addrList)}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "x-api-key": NEYNAR_API_KEY },
  });
  if (!res.ok) return {};
  const data = await res.json();
  // docs: response is an object mapping address -> user[]
  return data || {};
}

/** ============ STATE ============ */
const providers = {
  base: new ethers.JsonRpcProvider(BASE_RPC),
  hyperevm: new ethers.JsonRpcProvider(HYPEREVM_RPC),
};

const chainCfg = {
  base: { contract: BASE_CONTRACT, maxRange: BASE_MAX_RANGE, pollMs: BASE_POLL_MS },
  hyperevm: { contract: HYPEREVM_CONTRACT, maxRange: HYPEREVM_MAX_RANGE, pollMs: HYPEREVM_POLL_MS },
};

// counts by chain -> address -> count
const strikeCounts = {
  base: new Map(),
  hyperevm: new Map(),
};

// mappings
const addrToFid = new Map(); // address -> fid
const fidToUser = new Map(); // fid -> user object from neynar
const fidToAddresses = new Map(); // fid -> Set(addresses)

// health/poll status
const pollState = {
  base: { last: null, head: null, ok: true, lastError: "", lastScan: "" },
  hyperevm: { last: null, head: null, ok: true, lastError: "", lastScan: "" },
};

const pendingResolve = new Set(); // addresses we need to map -> fid

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function incCount(chain, address) {
  const a = address.toLowerCase();
  const m = strikeCounts[chain];
  m.set(a, (m.get(a) || 0) + 1);
}

function topicToAddress(topic) {
  // topic is 0x + 64 hex chars; last 40 hex chars are address
  if (!topic || typeof topic !== "string" || !topic.startsWith("0x") || topic.length < 66) return null;
  return ("0x" + topic.slice(-40)).toLowerCase();
}

function addFidMapping(fid, user) {
  const f = Number(fid);
  fidToUser.set(f, user);

  const set = fidToAddresses.get(f) || new Set();
  if (user?.custodyAddress) set.add(user.custodyAddress.toLowerCase());
  if (Array.isArray(user?.verifications)) user.verifications.forEach((a) => set.add(String(a).toLowerCase()));
  fidToAddresses.set(f, set);

  // Map all known addresses -> fid
  for (const a of set) addrToFid.set(a, f);
}

async function hydrateUser(fid) {
  const f = Number(fid);
  if (fidToUser.has(f)) return fidToUser.get(f);

  const user = await neynarUserByFid(f);
  if (!user) return null;

  addFidMapping(f, user);
  return user;
}

async function resolvePendingAddresses() {
  if (!NEYNAR_API_KEY) return;
  if (pendingResolve.size === 0) return;

  // take up to 50 at a time
  const batch = Array.from(pendingResolve).slice(0, 50);
  batch.forEach((a) => pendingResolve.delete(a));

  const data = await neynarByAddress(batch);

  // data shape: { "0xabc...": [user, user?], ... }
  for (const addr of batch) {
    const users = data?.[addr] || data?.[addr.toLowerCase()] || null;
    if (!Array.isArray(users) || users.length === 0) continue;

    // Safety: only accept UNIQUE mapping.
    // If multiple users share this verified address, skip mapping (prevents “wrong user” merges).
    if (users.length > 1) continue;

    const fid = users[0]?.fid;
    if (!fid) continue;

    await hydrateUser(fid);
  }
}

/** ============ LEADERBOARD (group by fid if known) ============ */
function buildLeaderboard(chain) {
  const m = strikeCounts[chain];
  const grouped = new Map(); // key -> { txCount, fid?, addresses:Set }

  for (const [addr, count] of m.entries()) {
    const fid = addrToFid.get(addr);
    const key = fid ? `fid:${fid}` : `addr:${addr}`;

    const g = grouped.get(key) || { txCount: 0, fid: fid || null, addresses: new Set() };
    g.txCount += count;
    g.addresses.add(addr);
    grouped.set(key, g);
  }

  const rows = Array.from(grouped.values())
    .map((g) => {
      if (g.fid) {
        const user = fidToUser.get(g.fid) || null;
        const username = user?.username || "";
        const displayName = user?.displayName || "";
        const pfpUrl = user?.pfpUrl || "";
        const walletCount = g.addresses.size;

        return {
          fid: g.fid,
          username,
          displayName,
          pfpUrl,
          walletCount,
          txCount: g.txCount,
        };
      }

      // no fid mapping
      const [first] = Array.from(g.addresses);
      return {
        fid: null,
        username: "",
        displayName: "",
        pfpUrl: "",
        walletCount: 1,
        address: first,
        txCount: g.txCount,
      };
    })
    .sort((a, b) => b.txCount - a.txCount);

  // rank
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** ============ PROFILE COUNTS ============ */
function getCountsForAddressOrFid(address, fid) {
  const res = { base: 0, hyperevm: 0 };

  if (fid) {
    const set = fidToAddresses.get(Number(fid)) || new Set();
    for (const chain of ["base", "hyperevm"]) {
      let sum = 0;
      for (const a of set) sum += strikeCounts[chain].get(a) || 0;
      res[chain] = sum;
    }
    return res;
  }

  // address-only fallback
  const a = String(address || "").toLowerCase();
  res.base = strikeCounts.base.get(a) || 0;
  res.hyperevm = strikeCounts.hyperevm.get(a) || 0;
  return res;
}

/** ============ POLLER ============ */
async function pollChain(chainKey) {
  const provider = providers[chainKey];
  const { contract, maxRange, pollMs } = chainCfg[chainKey];

  // determine initial fromBlock
  const head = await provider.getBlockNumber();
  pollState[chainKey].head = head;

  let fromBlock =
    chainKey === "base"
      ? (BASE_START_BLOCK ?? Math.max(0, head - 5000))
      : (HYPEREVM_START_BLOCK ?? Math.max(0, head - 2500));

  pollState[chainKey].last = fromBlock;

  while (true) {
    try {
      const headNow = await provider.getBlockNumber();
      pollState[chainKey].head = headNow;

      if (fromBlock > headNow) {
        pollState[chainKey].lastScan = `${fromBlock}-${headNow} logs=0`;
        await sleep(pollMs);
        continue;
      }

      const toBlock = Math.min(fromBlock + maxRange, headNow);

      const logs = await provider.getLogs({
        address: contract,
        fromBlock,
        toBlock,
        topics: [STRIKE_TOPIC0],
      });

      // process logs
      for (const log of logs) {
        const striker = topicToAddress(log?.topics?.[1]);
        if (!striker) continue;

        incCount(chainKey, striker);

        // queue resolve for merging
        if (!addrToFid.has(striker) && NEYNAR_API_KEY) pendingResolve.add(striker);
      }

      pollState[chainKey].ok = true;
      pollState[chainKey].lastError = "";
      pollState[chainKey].last = toBlock;
      pollState[chainKey].lastScan = `${fromBlock}-${toBlock} logs=${logs.length}`;

      // advance
      fromBlock = toBlock + 1;

      // try resolve a small batch each loop
      await resolvePendingAddresses();

      await sleep(pollMs);
    } catch (e) {
      const msg = String(e?.message || e || "");
      pollState[chainKey].ok = false;
      pollState[chainKey].lastError = msg;

      // If rate limited, backoff hard
      if (msg.toLowerCase().includes("rate") || msg.toLowerCase().includes("429")) {
        await sleep(RATE_LIMIT_BACKOFF_MS);
      } else {
        await sleep(pollMs);
      }
    }
  }
}

/** ============ ROUTES ============ */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    port: PORT,
    baseContract: BASE_CONTRACT,
    hyperevmContract: HYPEREVM_CONTRACT,
    base: pollState.base,
    hyperevm: pollState.hyperevm,
    basePlayers: buildLeaderboard("base").length,
    hyperevmPlayers: buildLeaderboard("hyperevm").length,
  });
});

// Leaderboards (FID-merged)
app.get("/api/leaderboard/base", (req, res) => res.json(buildLeaderboard("base")));
app.get("/api/leaderboard/hyperevm", (req, res) => res.json(buildLeaderboard("hyperevm")));

// Address profile (single address counts)
app.get("/api/profile/:address", async (req, res) => {
  const address = String(req.params.address || "").toLowerCase();
  const fid = addrToFid.get(address) || null;

  // if it maps to fid, hydrate to keep identity fresh
  if (fid) await hydrateUser(fid);

  res.json({
    address,
    fid,
    txCount: getCountsForAddressOrFid(address, null),
    // also include merged if known (handy for UI)
    mergedTxCount: fid ? getCountsForAddressOrFid(null, fid) : null,
  });
});

// ✅ NEW: FID profile (merged counts across all wallets)
app.get("/api/profile/fid/:fid", async (req, res) => {
  const fid = Number(req.params.fid);
  const user = await hydrateUser(fid);

  const counts = getCountsForAddressOrFid(null, fid);
  res.json({
    fid,
    user: user || null,
    txCount: counts,
  });
});

// Farcaster identity by fid (what your frontend already expects)
app.get("/api/farcaster/user/:fid", async (req, res) => {
  const fid = Number(req.params.fid);
  const user = await hydrateUser(fid);
  if (!user) return res.status(404).json({ error: "User not found (check NEYNAR_API_KEY)" });
  // return BOTH urls for compatibility
  res.json({
    ...user,
    farcasterUrl: user.farcasterUrl || (user.username ? `https://farcaster.xyz/${user.username}` : null),
  });
});

/** ============ START ============ */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`ChainWarZ backend listening on ${PORT}`);
  console.log(`Base RPC: ${BASE_RPC}`);
  console.log(`HyperEVM RPC: ${HYPEREVM_RPC}`);
  console.log(`Base contract: ${BASE_CONTRACT}`);
  console.log(`HyperEVM contract: ${HYPEREVM_CONTRACT}`);
});

// start pollers
pollChain("base");
pollChain("hyperevm");
