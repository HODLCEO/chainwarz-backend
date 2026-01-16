const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

// Hard kill-proofing
process.on("unhandledRejection", (reason) => console.error("UNHANDLED REJECTION:", reason));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));

// Config
const PORT = Number(process.env.PORT || 8080);

const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const HYPEREVM_RPC = process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm";

const BASE_CONTRACT =
  (process.env.BASE_CONTRACT || "0xB2B23e69b9d811D3D43AD473f90A171D18b19aab").toLowerCase();

const HYPEREVM_CONTRACT =
  (process.env.HYPEREVM_CONTRACT || "0x044A0B2D6eF67F5B82e51ec7229D84C0e83C8f02").toLowerCase();

const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY || "";

// Providers
let baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
let hyperProvider = new ethers.JsonRpcProvider(HYPEREVM_RPC);

// Strike topic0
const STRIKE_TOPIC0 = ethers.id("Strike(address,uint256,uint256)");

// In-memory stats
const stats = {
  base: new Map(),
  hyperevm: new Map(),
};

function fallbackProfile(addr) {
  return {
    username: "knight_" + addr.slice(2, 8),
    pfpUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${addr}`,
  };
}

async function fetchProfileByAddress(addr) {
  if (!NEYNAR_API_KEY) return fallbackProfile(addr);

  try {
    const url = `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${addr}`;
    const res = await fetch(url, {
      headers: { accept: "application/json", "x-api-key": NEYNAR_API_KEY },
    });
    if (!res.ok) return fallbackProfile(addr);

    const data = await res.json();
    const user = data?.[addr]?.[0];
    if (!user) return fallbackProfile(addr);

    return {
      username: user.username || fallbackProfile(addr).username,
      pfpUrl: user.pfp_url || fallbackProfile(addr).pfpUrl,
    };
  } catch (e) {
    console.error("neynar bulk-by-address error:", e?.message || e);
    return fallbackProfile(addr);
  }
}

async function fetchUserByFid(fid) {
  if (!NEYNAR_API_KEY) return null;

  try {
    const url = `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`;
    const res = await fetch(url, {
      headers: { accept: "application/json", "x-api-key": NEYNAR_API_KEY },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const user = data?.users?.[0];
    if (!user) return null;

    return {
      fid: user.fid,
      username: user.username,
      displayName: user.display_name,
      bio: user?.profile?.bio?.text || "",
      pfpUrl: user.pfp_url,
      warpcastUrl: user.username ? `https://warpcast.com/${user.username}` : null,
    };
  } catch (e) {
    console.error("neynar bulk-by-fid error:", e?.message || e);
    return null;
  }
}

function getProvider(chain) {
  return chain === "base" ? baseProvider : hyperProvider;
}
function resetProvider(chain) {
  if (chain === "base") baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
  else hyperProvider = new ethers.JsonRpcProvider(HYPEREVM_RPC);
}

// Poll settings
const POLL = {
  base: {
    address: BASE_CONTRACT,
    chunk: 2000,
    lookback: 8000,
    interval: 5000,
  },
  hyperevm: {
    address: HYPEREVM_CONTRACT,
    // ✅ smaller chunk helps avoid rate limits
    chunk: 100,
    lookback: 20000,
    // ✅ slower polling to reduce RPC pressure
    interval: 30000,
  },
};

const cursor = {
  base: { last: 0, head: 0, ok: true, lastError: "", lastScan: "", cooldownUntil: 0 },
  hyperevm: { last: 0, head: 0, ok: true, lastError: "", lastScan: "", cooldownUntil: 0 },
};

function nowMs() {
  return Date.now();
}

function bump(chain, addr) {
  const a = addr.toLowerCase();
  const row = stats[chain].get(a) || { txCount: 0, profile: null };
  row.txCount += 1;
  stats[chain].set(a, row);
}

async function safeGetBlockNumber(chain) {
  try {
    return await getProvider(chain).getBlockNumber();
  } catch (e) {
    cursor[chain].ok = false;
    cursor[chain].lastError = `getBlockNumber failed: ${e?.message || e}`;
    resetProvider(chain);
    return null;
  }
}

function isRateLimitError(msg) {
  const m = String(msg || "").toLowerCase();
  return m.includes("rate limit") || m.includes("rate limited") || m.includes("too many requests") || m.includes("429");
}

async function safeGetLogs(chain, fromBlock, toBlock) {
  if (fromBlock > toBlock) return [];

  try {
    const logs = await getProvider(chain).getLogs({
      address: POLL[chain].address,
      fromBlock,
      toBlock,
      topics: [STRIKE_TOPIC0],
    });

    cursor[chain].ok = true;
    cursor[chain].lastError = "";
    return logs || [];
  } catch (e) {
    const msg = e?.message || e;

    cursor[chain].ok = false;
    cursor[chain].lastError = `getLogs failed: ${msg}`;

    // ✅ if rate limited, back off HARD
    if (isRateLimitError(msg)) {
      const backoffMs = chain === "hyperevm" ? 120000 : 30000; // 2 minutes on HyperEVM
      cursor[chain].cooldownUntil = nowMs() + backoffMs;
      console.warn(`[${chain}] rate limited -> cooling down for ${Math.round(backoffMs / 1000)}s`);
    }

    resetProvider(chain);
    return null;
  }
}

async function pollOnce(chain) {
  const cfg = POLL[chain];

  // ✅ cooldown check
  if (cursor[chain].cooldownUntil && nowMs() < cursor[chain].cooldownUntil) return;

  const head = await safeGetBlockNumber(chain);
  if (head === null) return;

  cursor[chain].head = head;

  if (cursor[chain].last === 0) {
    cursor[chain].last = Math.max(0, head - cfg.lookback);
    console.log(`[${chain}] init cursor=${cursor[chain].last} head=${head}`);
    return;
  }

  if (cursor[chain].last > head) cursor[chain].last = Math.max(0, head - 1);

  const from = cursor[chain].last + 1;
  if (from > head) return;

  const to = Math.min(head, from + cfg.chunk);

  const logs = await safeGetLogs(chain, from, to);
  if (logs === null) {
    // do not advance cursor on failure
    return;
  }

  for (const log of logs) {
    const topic1 = log.topics?.[1];
    if (!topic1) continue;

    const addr = "0x" + topic1.slice(26);
    bump(chain, addr);

    const row = stats[chain].get(addr.toLowerCase());
    if (row && !row.profile) {
      row.profile = await fetchProfileByAddress(addr.toLowerCase());
      stats[chain].set(addr.toLowerCase(), row);
    }
  }

  cursor[chain].last = to;
  cursor[chain].lastScan = `${from}-${to} logs=${logs.length}`;
  console.log(`[${chain}] scanned ${from}-${to} logs=${logs.length} head=${head}`);
}

function startPolling() {
  setInterval(() => pollOnce("base"), POLL.base.interval);
  setInterval(() => pollOnce("hyperevm"), POLL.hyperevm.interval);

  pollOnce("base");
  pollOnce("hyperevm");
}

// Routes
app.get("/", (req, res) => res.status(200).send("ok"));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    port: PORT,
    baseContract: BASE_CONTRACT,
    hyperevmContract: HYPEREVM_CONTRACT,
    base: cursor.base,
    hyperevm: cursor.hyperevm,
    basePlayers: stats.base.size,
    hyperevmPlayers: stats.hyperevm.size,
  });
});

app.get("/api/leaderboard/:chain", (req, res) => {
  const chain = req.params.chain === "base" ? "base" : "hyperevm";
  const list = Array.from(stats[chain].entries())
    .map(([address, data]) => ({
      address,
      username: data.profile?.username || fallbackProfile(address).username,
      pfpUrl: data.profile?.pfpUrl || fallbackProfile(address).pfpUrl,
      txCount: data.txCount,
    }))
    .sort((a, b) => b.txCount - a.txCount)
    .slice(0, 25)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  res.json(list);
});

app.get("/api/profile/:address", (req, res) => {
  const addr = (req.params.address || "").toLowerCase();
  const b = stats.base.get(addr);
  const h = stats.hyperevm.get(addr);

  const profile = b?.profile || h?.profile || fallbackProfile(addr);

  res.json({
    ...profile,
    txCount: {
      base: b?.txCount || 0,
      hyperevm: h?.txCount || 0,
    },
  });
});

app.get("/api/farcaster/user/:fid", async (req, res) => {
  const fid = Number(req.params.fid);
  if (!fid || Number.isNaN(fid)) return res.status(400).json({ error: "Invalid fid" });

  const user = await fetchUserByFid(fid);
  if (!user) return res.status(404).json({ error: "User not found" });

  res.json(user);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ChainWarZ Backend listening on ${PORT}`);
  console.log(`Base RPC: ${BASE_RPC}`);
  console.log(`HyperEVM RPC: ${HYPEREVM_RPC}`);
  console.log(`Base contract: ${BASE_CONTRACT}`);
  console.log(`HyperEVM contract: ${HYPEREVM_CONTRACT}`);
  startPolling();
});
