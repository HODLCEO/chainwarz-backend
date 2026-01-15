const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 8080);

const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const HYPEREVM_RPC = process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm";

const BASE_CONTRACT =
  (process.env.BASE_CONTRACT || "0xB2B23e69b9d811D3D43AD473f90A171D18b19aab").toLowerCase();

const HYPEREVM_CONTRACT =
  (process.env.HYPEREVM_CONTRACT || "0x044A0B2D6eF67F5B82e51ec7229D84C0e83C8f02").toLowerCase();

// Neynar optional (still fine if missing)
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY || "";

// ------------ Providers (recreated on error) ------------
let baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
let hyperProvider = new ethers.JsonRpcProvider(HYPEREVM_RPC);

// Strike event signature topic0
const STRIKE_TOPIC0 = ethers.id("Strike(address,uint256,uint256)");

// In-memory stats
const stats = {
  base: new Map(), // address -> { txCount, profile? }
  hyperevm: new Map(),
};

function bump(chain, address) {
  const a = address.toLowerCase();
  const cur = stats[chain].get(a) || { txCount: 0, profile: null };
  cur.txCount += 1;
  stats[chain].set(a, cur);
}

// (Optional) profile hydration for leaderboard (works without Neynar too)
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
      headers: {
        accept: "application/json",
        "x-api-key": NEYNAR_API_KEY,
      },
    });

    if (!res.ok) return fallbackProfile(addr);
    const data = await res.json();

    const user = data?.[addr]?.[0];
    if (!user) return fallbackProfile(addr);

    return {
      username: user.username || fallbackProfile(addr).username,
      pfpUrl: user.pfp_url || fallbackProfile(addr).pfpUrl,
    };
  } catch {
    return fallbackProfile(addr);
  }
}

async function fetchUserByFid(fid) {
  if (!NEYNAR_API_KEY) return null;

  try {
    const url = `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`;
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "x-api-key": NEYNAR_API_KEY,
      },
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
  } catch {
    return null;
  }
}

// ------------ Resilient log polling ------------
const POLL = {
  base: {
    chain: "base",
    address: BASE_CONTRACT,
    // bigger is fine on Base, but keep reasonable
    chunkSize: 2000,
    // start a bit back to catch recent strikes
    lookback: 6000,
    intervalMs: 5000,
  },
  hyperevm: {
    chain: "hyperevm",
    address: HYPEREVM_CONTRACT,
    // HyperEVM nodes are picky -> keep chunks small
    chunkSize: 400,
    lookback: 12000,
    intervalMs: 9000,
  },
};

const cursors = {
  base: { last: 0, head: 0, ok: true, lastError: "" },
  hyperevm: { last: 0, head: 0, ok: true, lastError: "" },
};

function getProvider(chain) {
  return chain === "base" ? baseProvider : hyperProvider;
}

function resetProvider(chain) {
  if (chain === "base") baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
  else hyperProvider = new ethers.JsonRpcProvider(HYPEREVM_RPC);
}

async function safeGetBlockNumber(chain) {
  try {
    const p = getProvider(chain);
    return await p.getBlockNumber();
  } catch (e) {
    cursors[chain].ok = false;
    cursors[chain].lastError = `getBlockNumber failed: ${e?.message || e}`;
    resetProvider(chain);
    return null;
  }
}

async function safeGetLogs(chain, fromBlock, toBlock) {
  const p = getProvider(chain);

  // never send invalid ranges
  if (fromBlock > toBlock) return [];

  try {
    const logs = await p.getLogs({
      address: POLL[chain].address,
      fromBlock,
      toBlock,
      topics: [STRIKE_TOPIC0],
    });

    cursors[chain].ok = true;
    cursors[chain].lastError = "";
    return logs || [];
  } catch (e) {
    // DO NOT advance cursor on errors
    cursors[chain].ok = false;
    cursors[chain].lastError = `getLogs failed: ${e?.message || e}`;

    // If RPC is flaky, recreate provider and try again next tick
    resetProvider(chain);
    return null;
  }
}

async function pollOnce(chain) {
  const cfg = POLL[chain];

  // 1) find head
  const head = await safeGetBlockNumber(chain);
  if (head === null) return;

  cursors[chain].head = head;

  // 2) init cursor
  if (cursors[chain].last === 0) {
    cursors[chain].last = Math.max(0, head - cfg.lookback);
    console.log(`[${chain}] initialized cursor at ${cursors[chain].last} (head=${head})`);
    return;
  }

  // 3) if cursor somehow got ahead of head, pull it back
  if (cursors[chain].last > head) {
    cursors[chain].last = Math.max(0, head - 1);
  }

  // 4) scan ONE chunk per tick (stable & avoids timeouts)
  const from = cursors[chain].last + 1;
  if (from > head) return;

  const to = Math.min(head, from + cfg.chunkSize);

  const logs = await safeGetLogs(chain, from, to);
  if (logs === null) {
    // failed -> do not advance cursor, try later
    return;
  }

  // 5) decode minimal: topic[1] is indexed player address (right padded)
  for (const log of logs) {
    // topics[1] = indexed address
    const topic1 = log.topics?.[1];
    if (!topic1) continue;
    const addr = "0x" + topic1.slice(26); // last 40 hex chars
    bump(chain, addr);

    // hydrate profile once for leaderboard niceness
    const row = stats[chain].get(addr.toLowerCase());
    if (row && !row.profile) {
      row.profile = await fetchProfileByAddress(addr.toLowerCase());
      stats[chain].set(addr.toLowerCase(), row);
    }
  }

  // 6) advance cursor only after success
  cursors[chain].last = to;

  console.log(`[${chain}] scanned ${from}-${to} logs=${logs.length} head=${head}`);
}

function startPolling() {
  setInterval(() => pollOnce("base"), POLL.base.intervalMs);
  setInterval(() => pollOnce("hyperevm"), POLL.hyperevm.intervalMs);

  // kick once immediately
  pollOnce("base");
  pollOnce("hyperevm");
}

// ------------ Routes ------------
app.get("/", (req, res) => res.status(200).send("ok"));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    port: PORT,
    base: cursors.base,
    hyperevm: cursors.hyperevm,
    basePlayers: stats.base.size,
    hyperevmPlayers: stats.hyperevm.size,
  });
});

app.get("/api/leaderboard/:chain", (req, res) => {
  const key = req.params.chain === "base" ? "base" : "hyperevm";
  const list = Array.from(stats[key].entries())
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
  const address = (req.params.address || "").toLowerCase();
  const baseRow = stats.base.get(address);
  const hyperRow = stats.hyperevm.get(address);

  const profile = baseRow?.profile || hyperRow?.profile || fallbackProfile(address);

  res.json({
    ...profile,
    txCount: {
      base: baseRow?.txCount || 0,
      hyperevm: hyperRow?.txCount || 0,
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
