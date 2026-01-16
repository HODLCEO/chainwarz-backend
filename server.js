// server.js (ESM) — ChainWarZ backend
import express from "express";
import cors from "cors";
import { ethers } from "ethers";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 8080);

// --- RPCs / Contracts ---
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const HYPEREVM_RPC = process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm";

const BASE_CONTRACT =
  process.env.BASE_CONTRACT || "0xB2B23e69b9d811D3D43AD473f90A171D18b19aab";

const HYPEREVM_CONTRACT =
  process.env.HYPEREVM_CONTRACT || "0x044A0B2D6eF67F5B82e51ec7229D84C0e83C8f02";

// Strike event topic (your logs show this is the event being indexed)
const STRIKE_TOPIC = ethers.id("Strike(address)");

// --- Neynar ---
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY || "";
const NEYNAR_BASE = "https://api.neynar.com/v2/farcaster";

function assertNeynar() {
  if (!NEYNAR_API_KEY) {
    throw new Error("Missing NEYNAR_API_KEY env var");
  }
}

async function neynarGet(path, params = {}) {
  assertNeynar();
  const u = new URL(`${NEYNAR_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  const res = await fetch(u.toString(), {
    headers: { "x-api-key": NEYNAR_API_KEY },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Neynar ${res.status}: ${t || res.statusText}`);
  }
  return res.json();
}

// Simple in-memory cache
const cache = new Map();
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) {
    cache.delete(key);
    return null;
  }
  return v.val;
}
function cacheSet(key, val, ttlMs = 5 * 60 * 1000) {
  cache.set(key, { val, exp: Date.now() + ttlMs });
}

// --- Chain polling state ---
const providers = {
  base: new ethers.JsonRpcProvider(BASE_RPC),
  hyperevm: new ethers.JsonRpcProvider(HYPEREVM_RPC),
};

const contracts = {
  base: ethers.getAddress(BASE_CONTRACT),
  hyperevm: ethers.getAddress(HYPEREVM_CONTRACT),
};

// txCounts[chain][addressLower] = count
const txCounts = {
  base: new Map(),
  hyperevm: new Map(),
};

const poll = {
  base: { last: 0, head: 0, ok: false, lastError: "", lastScan: "" },
  hyperevm: { last: 0, head: 0, ok: false, lastError: "", lastScan: "" },
};

// Helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function incCount(chainKey, addrLower) {
  const m = txCounts[chainKey];
  m.set(addrLower, (m.get(addrLower) || 0) + 1);
}

function parseIndexedAddress(topic1) {
  // topic is 32-byte hex, last 20 bytes are address
  return ("0x" + topic1.slice(26)).toLowerCase();
}

function uniqLower(addrs) {
  const s = new Set();
  for (const a of addrs) if (a) s.add(a.toLowerCase());
  return [...s];
}

// --- Neynar user by fid (bulk) ---
// Docs: /v2/farcaster/user/bulk?fids=... :contentReference[oaicite:1]{index=1}
async function getUserByFid(fid) {
  const key = `fid:${fid}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const data = await neynarGet("/user/bulk", { fids: fid });
  const user = Array.isArray(data?.users) ? data.users[0] : null;

  cacheSet(key, user || null);
  return user || null;
}

function userToIdentity(user) {
  if (!user) return null;
  const username = user.username || "";
  const displayName = user.display_name || user.displayName || username;
  const pfpUrl = user.pfp_url || user.pfpUrl || "";
  const bio =
    user?.profile?.bio?.text ||
    user?.profile?.bio ||
    user?.bio ||
    "";
  const warpcastUrl = username ? `https://warpcast.com/${username}` : null;

  const custodyAddress = (user.custody_address || "").toLowerCase();
  const verifications = Array.isArray(user.verifications)
    ? user.verifications.map((a) => String(a).toLowerCase())
    : [];

  const wallets = uniqLower([custodyAddress, ...verifications]);

  return {
    fid: user.fid,
    username,
    displayName,
    pfpUrl,
    bio,
    warpcastUrl,
    custodyAddress: custodyAddress || null,
    wallets,
  };
}

// --- Address → Farcaster users (bulk-by-address) ---
// Docs: /v2/farcaster/user/bulk-by-address?addresses=... :contentReference[oaicite:2]{index=2}
async function bulkByAddress(addresses, address_types) {
  if (!addresses.length) return {};
  const key = `bulkaddr:${address_types}:${addresses.join(",")}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const data = await neynarGet("/user/bulk-by-address", {
    addresses: addresses.join(","),
    address_types, // "custody_address" or "verified_address"
    chain: "ethereum",
  });

  // Response is an object keyed by address, value is array of users :contentReference[oaicite:3]{index=3}
  cacheSet(key, data, 2 * 60 * 1000);
  return data || {};
}

function pickUniqueUser(usersArray) {
  // Neynar warns verified addresses can map to multiple users :contentReference[oaicite:4]{index=4}
  if (!Array.isArray(usersArray)) return null;
  if (usersArray.length !== 1) return null;
  return usersArray[0];
}

// Safe resolver: custody first, then verified-only-if-unique
async function resolveAddressesToIdentity(addressesLower) {
  const result = new Map(); // addrLower -> identity

  // 1) custody_address mapping
  const custodyResp = await bulkByAddress(addressesLower, "custody_address");
  for (const [addr, users] of Object.entries(custodyResp || {})) {
    const u = pickUniqueUser(users);
    if (u) result.set(addr.toLowerCase(), userToIdentity(u));
  }

  // 2) verified_address mapping (only fill missing; only unique)
  const missing = addressesLower.filter((a) => !result.has(a));
  if (missing.length) {
    const verifiedResp = await bulkByAddress(missing, "verified_address");
    for (const [addr, users] of Object.entries(verifiedResp || {})) {
      const u = pickUniqueUser(users);
      if (u) result.set(addr.toLowerCase(), userToIdentity(u));
    }
  }

  return result;
}

// --- Leaderboard builder ---
async function buildLeaderboard(chainKey) {
  const entries = [...txCounts[chainKey].entries()].map(([address, txCount]) => ({
    address,
    txCount,
  }));
  entries.sort((a, b) => b.txCount - a.txCount);

  const top = entries.slice(0, 250);
  const addresses = top.map((x) => x.address.toLowerCase());

  let addrToIdent = new Map();
  try {
    // Don’t crash leaderboard if Neynar is temporarily down/rate-limited
    if (NEYNAR_API_KEY) {
      addrToIdent = await resolveAddressesToIdentity(addresses);
    }
  } catch {
    addrToIdent = new Map();
  }

  // Merge by FID
  const byFid = new Map(); // fid -> row
  const anon = [];

  for (const row of top) {
    const ident = addrToIdent.get(row.address.toLowerCase()) || null;

    if (ident?.fid) {
      const fid = ident.fid;
      if (!byFid.has(fid)) {
        byFid.set(fid, {
          fid,
          username: ident.username,
          displayName: ident.displayName,
          pfpUrl: ident.pfpUrl,
          walletCount: 0,
          txCount: 0,
          // NOTE: we do NOT return a "random address" anymore for Farcaster rows.
        });
      }
      const r = byFid.get(fid);
      r.txCount += row.txCount;
      r.walletCount += 1; // number of strike-wallets that contributed
    } else {
      // Keep unlinked wallets as separate rows
      anon.push({
        address: row.address,
        txCount: row.txCount,
      });
    }
  }

  const merged = [...byFid.values(), ...anon];
  merged.sort((a, b) => b.txCount - a.txCount);

  // Rank
  return merged.slice(0, 50).map((r, i) => ({ ...r, rank: i + 1 }));
}

// --- Profile counts ---
// By address (single wallet)
app.get("/api/profile/:address", async (req, res) => {
  try {
    const addr = String(req.params.address || "").toLowerCase();
    const base = txCounts.base.get(addr) || 0;
    const hyp = txCounts.hyperevm.get(addr) || 0;

    let identity = null;
    if (NEYNAR_API_KEY) {
      try {
        const map = await resolveAddressesToIdentity([addr]);
        identity = map.get(addr) || null;
      } catch {}
    }

    res.json({
      address: addr,
      txCount: { base, hyperevm: hyp },
      identity,
    });
  } catch (e) {
    res.status(500).json({ error: "profile_failed" });
  }
});

// By fid (merge ALL wallets known on Farcaster into one score)
app.get("/api/profile/by-fid/:fid", async (req, res) => {
  try {
    const fid = Number(req.params.fid);
    if (!fid) return res.status(400).json({ error: "bad_fid" });

    const user = await getUserByFid(fid);
    const ident = userToIdentity(user);

    if (!ident) return res.json({ fid, identity: null, txCount: { base: 0, hyperevm: 0 } });

    let base = 0;
    let hyp = 0;

    for (const w of ident.wallets) {
      base += txCounts.base.get(w) || 0;
      hyp += txCounts.hyperevm.get(w) || 0;
    }

    res.json({
      fid,
      identity: ident,
      txCount: { base, hyperevm: hyp },
      walletCount: ident.wallets.length,
    });
  } catch {
    res.status(500).json({ error: "profile_by_fid_failed" });
  }
});

// Leaderboards (merged by Farcaster user where possible)
app.get("/api/leaderboard/:chain", async (req, res) => {
  try {
    const chain = String(req.params.chain || "");
    if (!["base", "hyperevm"].includes(chain)) return res.status(404).json({ error: "bad_chain" });
    const rows = await buildLeaderboard(chain);
    res.json(rows);
  } catch {
    res.status(500).json({ error: "leaderboard_failed" });
  }
});

// Health
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    port: PORT,
    baseContract: contracts.base,
    hyperevmContract: contracts.hyperevm,
    base: poll.base,
    hyperevm: poll.hyperevm,
    basePlayers: txCounts.base.size,
    hyperevmPlayers: txCounts.hyperevm.size,
  });
});

// --- Poller ---
// HyperEVM public RPC is rate-limited; keep requests low by scanning small windows + slower interval. :contentReference[oaicite:5]{index=5}
async function startPoller(chainKey, { intervalMs, maxStep }) {
  const provider = providers[chainKey];
  const contract = contracts[chainKey];

  // Init last block
  const head = await provider.getBlockNumber();
  poll[chainKey].head = head;
  poll[chainKey].last = Math.max(0, head - 2000);
  poll[chainKey].ok = true;
  poll[chainKey].lastError = "";
  poll[chainKey].lastScan = `init:${poll[chainKey].last}-${head}`;

  // Single-flight loop (no overlap)
  (async function loop() {
    while (true) {
      try {
        const headNow = await provider.getBlockNumber();
        poll[chainKey].head = headNow;

        let fromBlock = poll[chainKey].last + 1;
        if (fromBlock < 0) fromBlock = 0;

        // Scan in small chunks to avoid "invalid block range" / "max block range" errors
        const toBlock = Math.min(headNow, fromBlock + maxStep);

        // If already caught up, idle
        if (fromBlock > headNow) {
          poll[chainKey].ok = true;
          poll[chainKey].lastError = "";
          poll[chainKey].lastScan = `caught_up:${headNow}`;
          await sleep(intervalMs);
          continue;
        }

        const logs = await provider.getLogs({
          address: contract,
          fromBlock,
          toBlock,
          topics: [STRIKE_TOPIC],
        });

        for (const log of logs) {
          if (!log?.topics?.[1]) continue;
          const striker = parseIndexedAddress(log.topics[1]);
          incCount(chainKey, striker);
        }

        poll[chainKey].last = toBlock;
        poll[chainKey].ok = true;
        poll[chainKey].lastError = "";
        poll[chainKey].lastScan = `${fromBlock}-${toBlock} logs=${logs.length}`;
      } catch (e) {
        const msg = String(e?.message || e || "");
        poll[chainKey].ok = false;
        poll[chainKey].lastError = msg.slice(0, 300);

        // Backoff harder on rate limit
        if (msg.toLowerCase().includes("rate limit") || msg.includes("32005")) {
          await sleep(Math.max(intervalMs, 20000));
          continue;
        }
      }

      await sleep(intervalMs);
    }
  })();
}

app.listen(PORT, async () => {
  console.log(`ChainWarZ backend listening on ${PORT}`);
  console.log(`Base RPC: ${BASE_RPC}`);
  console.log(`HyperEVM RPC: ${HYPEREVM_RPC}`);
  console.log(`Base contract: ${contracts.base}`);
  console.log(`HyperEVM contract: ${contracts.hyperevm}`);

  // Base can poll faster, HyperEVM slower to avoid RPC rate limit
  await startPoller("base", { intervalMs: 6000, maxStep: 800 });
  await startPoller("hyperevm", { intervalMs: 14000, maxStep: 400 });
});
