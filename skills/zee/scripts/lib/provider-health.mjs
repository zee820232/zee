/**
 * zee 跨会话上游故障（HTTP 429 配额 / 5xx 断连）熔断缓存与健康切备（v4.2.1）
 *
 * 设计约束：
 * 1. 仅由 pi-extension/index.ts 与 skills/zee/scripts/zee-tool.mjs 引用；严禁被 pi-extension/fsm.ts 导入（保持纯内存零 fs 不变量）。
 * 2. 所有路径支持环境变量覆写（ZEE_PROVIDER_HEALTH_PATH / ZEE_CONFIG_PATH），确保单测 100% 隔离不污染真实用户目录。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractModelFamily } from "./guard-core.mjs";

export const DEFAULT_PROVIDER_HEALTH_PATH = path.join(os.homedir(), ".local", "state", "zee", "provider-health.json");
export const DEFAULT_429_COOLDOWN_MS = Number(process.env.ZEE_COOLDOWN_429_MS) || 30 * 60 * 1000;
export const DEFAULT_5XX_COOLDOWN_MS = Number(process.env.ZEE_COOLDOWN_5XX_MS) || 5 * 60 * 1000;

const RATE_LIMIT_RE =
  /\b429\b|rate[\s_-]*limit|too many requests|quota[\s_-]*exhausted|insufficient_quota|resource_exhausted|quota exceeded/i;
const TRANSIENT_5XX_RE =
  /\b(?:502|503|504|529)\b|overloaded|service unavailable|bad gateway|gateway timeout|econnreset|econnrefused|etimedout|fetch failed|socket hang up/i;

function get429TtlMs() {
  const n = Number(process.env.ZEE_COOLDOWN_429_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_429_COOLDOWN_MS;
}

function get5xxTtlMs() {
  const n = Number(process.env.ZEE_COOLDOWN_5XX_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_5XX_COOLDOWN_MS;
}

export function resolveProviderHealthPath(explicitPath) {
  if (typeof explicitPath === "string" && explicitPath.trim()) {
    return path.resolve(explicitPath.trim());
  }
  const envPath = process.env.ZEE_PROVIDER_HEALTH_PATH?.trim();
  if (envPath) return path.resolve(envPath);
  return DEFAULT_PROVIDER_HEALTH_PATH;
}

export function makeModelHealthKey(provider, model) {
  const p = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  const m = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (p && m) return `${p}/${m}`;
  return m || p;
}

export function classifyTransientProviderFailure({
  errorMessage = "",
  stderrText = "",
  exitCode = null,
  turns = 0,
  hasOutput = false,
  hasToolCalls = false,
  outputTokens = 0,
} = {}) {
  const turnCount = Number(turns) || 0;
  const outTokens = Number(outputTokens) || 0;
  if (hasOutput || hasToolCalls || outTokens > 0 || turnCount > 1) {
    return { transient: false, kind: null, ttlMs: 0, reason: "" };
  }
  const combined = `${errorMessage || ""}\n${stderrText || ""}`.trim();
  if (!combined) {
    return { transient: false, kind: null, ttlMs: 0, reason: "" };
  }
  if (RATE_LIMIT_RE.test(combined)) {
    return {
      transient: true,
      kind: "rate_limit",
      ttlMs: get429TtlMs(),
      reason: "HTTP 429 / 配额耗尽",
    };
  }
  if (TRANSIENT_5XX_RE.test(combined)) {
    return {
      transient: true,
      kind: "transient_5xx",
      ttlMs: get5xxTtlMs(),
      reason: exitCode !== null && exitCode !== undefined ? `上游 5xx / 网络建连失败 (exit=${exitCode})` : "上游 5xx / 网络建连失败",
    };
  }
  return { transient: false, kind: null, ttlMs: 0, reason: "" };
}

function readRawHealthObject(healthPath) {
  if (!fs.existsSync(healthPath)) return { version: 1, models: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(healthPath, "utf8"));
    const rawModels = parsed && typeof parsed === "object" && parsed.models && typeof parsed.models === "object" && !Array.isArray(parsed.models)
      ? parsed.models
      : {};
    return { version: 1, models: { ...rawModels } };
  } catch {
    return { version: 1, models: {} };
  }
}

function writeHealthAtomic(healthPath, data) {
  fs.mkdirSync(path.dirname(healthPath), { recursive: true });
  const tmp = `${healthPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, models: data.models || {} }, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, healthPath);
}

export function readProviderHealth(filePath, now = Date.now()) {
  const healthPath = resolveProviderHealthPath(filePath);
  const raw = readRawHealthObject(healthPath);
  const models = {};
  for (const [k, entry] of Object.entries(raw.models)) {
    if (!entry || typeof entry !== "object") continue;
    const until = Number(entry.cooldownUntil);
    if (Number.isFinite(until) && until > now) {
      models[k] = entry;
    }
  }
  return { version: 1, models };
}

export function getModelCooldown(provider, model, now = Date.now(), filePath) {
  const health = readProviderHealth(filePath, now);
  const fullKey = makeModelHealthKey(provider, model);
  const modelKey = makeModelHealthKey(undefined, model);

  let matchedKey = "";
  let entry = null;
  if (fullKey && health.models[fullKey]) {
    matchedKey = fullKey;
    entry = health.models[fullKey];
  } else if (modelKey && health.models[modelKey]) {
    matchedKey = modelKey;
    entry = health.models[modelKey];
  }

  if (!entry) {
    return { active: false, key: fullKey || modelKey, remainingMs: 0, remainingSec: 0, entry: null };
  }
  const remainingMs = Math.max(0, Number(entry.cooldownUntil) - now);
  return {
    active: remainingMs > 0,
    key: matchedKey,
    remainingMs,
    remainingSec: Math.ceil(remainingMs / 1000),
    entry,
  };
}

export function recordModelCooldown(provider, model, meta = {}, filePath, now = Date.now()) {
  const key = makeModelHealthKey(provider, model);
  const healthPath = resolveProviderHealthPath(filePath);
  if (!key) return null;

  const current = readProviderHealth(healthPath, now);
  const prev = current.models[key];
  const kind = meta.kind || "rate_limit";
  const ttlMs = Math.max(1000, Number(meta.ttlMs) || (kind === "rate_limit" ? get429TtlMs() : get5xxTtlMs()));
  const nextEntry = {
    provider: typeof provider === "string" && provider.trim() ? provider.trim() : undefined,
    model: typeof model === "string" && model.trim() ? model.trim() : undefined,
    kind,
    reason: String(meta.reason || (kind === "rate_limit" ? "HTTP 429 / 配额耗尽" : "上游 5xx / 网络建连失败")),
    errorSnippet: String(meta.errorSnippet || "").replace(/\s+/g, " ").trim().slice(0, 300),
    failures: (Number(prev?.failures) || 0) + 1,
    failedAt: new Date(now).toISOString(),
    cooldownUntil: now + ttlMs,
    ttlMs,
  };
  current.models[key] = nextEntry;
  writeHealthAtomic(healthPath, current);
  return { key, healthPath, ...nextEntry };
}

export function clearModelCooldown(targetKey, filePath) {
  const healthPath = resolveProviderHealthPath(filePath);
  if (!fs.existsSync(healthPath)) {
    return { clearedCount: 0, remainingCount: 0, healthPath };
  }
  const raw = readRawHealthObject(healthPath);
  const keys = Object.keys(raw.models);
  if (keys.length === 0) {
    return { clearedCount: 0, remainingCount: 0, healthPath };
  }

  const query = typeof targetKey === "string" ? targetKey.trim().toLowerCase() : "";
  if (!query) {
    writeHealthAtomic(healthPath, { version: 1, models: {} });
    return { clearedCount: keys.length, remainingCount: 0, healthPath };
  }

  let clearedCount = 0;
  const nextModels = {};
  for (const k of keys) {
    const kLow = k.toLowerCase();
    if (kLow === query || kLow.endsWith(`/${query}`) || kLow.includes(query)) {
      clearedCount += 1;
    } else {
      nextModels[k] = raw.models[k];
    }
  }
  if (clearedCount > 0) {
    writeHealthAtomic(healthPath, { version: 1, models: nextModels });
  }
  return {
    clearedCount,
    remainingCount: Object.keys(nextModels).length,
    healthPath,
  };
}

export function listActiveCooldowns(now = Date.now(), filePath) {
  const health = readProviderHealth(filePath, now);
  return Object.entries(health.models)
    .map(([key, entry]) => {
      const cooldownUntil = Number(entry.cooldownUntil);
      const remainingMs = Math.max(0, cooldownUntil - now);
      return {
        key,
        provider: entry.provider || null,
        model: entry.model || null,
        kind: entry.kind || "rate_limit",
        reason: entry.reason || "",
        failures: Number(entry.failures) || 1,
        failedAt: entry.failedAt || null,
        cooldownUntil,
        remainingSec: Math.ceil(remainingMs / 1000),
        errorSnippet: entry.errorSnippet || "",
      };
    })
    .sort((a, b) => b.cooldownUntil - a.cooldownUntil);
}

function collectSlotPiCandidates(slotObj, slotLabel, out) {
  if (!slotObj || typeof slotObj !== "object") return;
  const pushPair = (b, label) => {
    if (!b || typeof b !== "object") return;
    if (typeof b.providerInstanceId === "string" && typeof b.model === "string") {
      const p = b.providerInstanceId.trim();
      const m = b.model.trim();
      if (p && m) out.push({ provider: p, model: m, slotLabel: label });
    }
    if (b.prefer) pushPair(b.prefer, `${label}.prefer`);
    if (b.backup) pushPair(b.backup, `${label}.backup`);
  };

  if (slotObj.bindings?.pi) {
    pushPair(slotObj.bindings.pi, slotLabel);
  }
  if (slotObj.prefer?.bindings?.pi) {
    pushPair(slotObj.prefer.bindings.pi, `${slotLabel}.prefer`);
  }
  if (slotObj.backup?.bindings?.pi) {
    pushPair(slotObj.backup.bindings.pi, `${slotLabel}.backup`);
  }
}

export function findHealthyPiFallback({
  role = "coder",
  failedProvider,
  failedModel,
  authorFamily,
  configPath,
  healthPath,
  now = Date.now(),
} = {}) {
  const cfgPath =
    typeof configPath === "string" && configPath.trim()
      ? path.resolve(configPath.trim())
      : process.env.ZEE_CONFIG_PATH?.trim()
        ? path.resolve(process.env.ZEE_CONFIG_PATH.trim())
        : path.join(os.homedir(), ".agents", "zee-config.json");

  if (!fs.existsSync(cfgPath)) return null;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    return null;
  }

  const roles = cfg?.roles;
  if (!roles || typeof roles !== "object") return null;

  const r = String(role || "").trim().toLowerCase();
  const candidates = [];
  if (r === "reviewer") {
    if (Array.isArray(roles.reviewers)) {
      roles.reviewers.forEach((rev, i) => collectSlotPiCandidates(rev, `reviewers[${i}]`, candidates));
    }
  } else if (r === "judge") {
    if (Array.isArray(roles.judge)) {
      roles.judge.forEach((j, i) => collectSlotPiCandidates(j, `judge[${i}]`, candidates));
    } else if (roles.judge) {
      collectSlotPiCandidates(roles.judge, "judge", candidates);
    }
    if (Array.isArray(roles.reviewers)) {
      roles.reviewers.forEach((rev, i) => collectSlotPiCandidates(rev, `reviewers[${i}]`, candidates));
    }
  } else if (r === "scout") {
    collectSlotPiCandidates(roles.scout, "scout", candidates);
  } else if (r === "verifier") {
    collectSlotPiCandidates(roles.verifier, "verifier", candidates);
  } else if (r === "architect") {
    collectSlotPiCandidates(roles.architect?.primary, "architect.primary", candidates);
    if (Array.isArray(roles.architect?.arenaPool)) {
      roles.architect.arenaPool.forEach((a, i) => collectSlotPiCandidates(a, `architect.arenaPool[${i}]`, candidates));
    }
  } else if (r === "coder" || r === "ui") {
    collectSlotPiCandidates(roles[r]?.standard, `${r}.standard`, candidates);
    collectSlotPiCandidates(roles[r]?.heavy, `${r}.heavy`, candidates);
  } else if (roles[r]) {
    collectSlotPiCandidates(roles[r], r, candidates);
  }

  const failedKey = makeModelHealthKey(failedProvider, failedModel);
  const failedModelKey = makeModelHealthKey(undefined, failedModel);
  const authFam = authorFamily ? extractModelFamily(authorFamily) : "";
  const seen = new Set();

  for (const cand of candidates) {
    const candKey = makeModelHealthKey(cand.provider, cand.model);
    if (!candKey || seen.has(candKey)) continue;
    seen.add(candKey);

    if (candKey === failedKey) continue;
    if (!failedProvider && failedModelKey && cand.model.trim().toLowerCase() === failedModelKey) continue;

    const fam = extractModelFamily(cand.model);
    if (r === "reviewer" && authFam && fam && fam === authFam) continue;

    const cd = getModelCooldown(cand.provider, cand.model, now, healthPath);
    if (cd.active) continue;

    return {
      provider: cand.provider,
      model: cand.model,
      family: fam,
      slotLabel: cand.slotLabel,
    };
  }

  return null;
}
