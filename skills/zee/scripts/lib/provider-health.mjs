/**
 * zee 跨会话上游故障（HTTP 429 配额 / 5xx 断连）熔断缓存与健康切备（v5.2.0）
 *
 * 兼容 schema v3 (harnesses.pi.slots / cfg.slots: fast / workhorse / adversary) 与 legacy schema v2 (cfg.roles)。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractModelFamily } from "./guard-core.mjs";
import { atomicWriteJson, withFileLock } from "./fs-atomic.mjs";
import { stripAnsiAndControl } from "./repo-utils.mjs";

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
    return { transient: true, kind: "rate_limit", ttlMs: get429TtlMs(), reason: "HTTP 429 / 配额耗尽" };
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
    const rawModels =
      parsed && typeof parsed === "object" && parsed.models && typeof parsed.models === "object" && !Array.isArray(parsed.models)
        ? parsed.models
        : {};
    return { version: 1, models: { ...rawModels } };
  } catch {
    return { version: 1, models: {} };
  }
}

function writeHealthAtomic(healthPath, data) {
  atomicWriteJson(healthPath, { version: 1, models: data.models || {} });
}

export function readProviderHealth(filePath, now = Date.now()) {
  const healthPath = resolveProviderHealthPath(filePath);
  const raw = readRawHealthObject(healthPath);
  const models = {};
  for (const [k, entry] of Object.entries(raw.models)) {
    if (!entry || typeof entry !== "object") continue;
    const until = Number(entry.cooldownUntil);
    if (Number.isFinite(until) && until > now) models[k] = entry;
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

  return withFileLock(healthPath, () => {
    const current = readProviderHealth(healthPath, now);
    const prev = current.models[key];
    const kind = meta.kind || "rate_limit";
    const ttlMs = Math.max(1000, Number(meta.ttlMs) || (kind === "rate_limit" ? get429TtlMs() : get5xxTtlMs()));
    const nextEntry = {
      provider: typeof provider === "string" && provider.trim() ? provider.trim() : undefined,
      model: typeof model === "string" && model.trim() ? model.trim() : undefined,
      kind,
      reason: stripAnsiAndControl(String(meta.reason || (kind === "rate_limit" ? "HTTP 429 / 配额耗尽" : "上游 5xx / 网络建连失败"))),
      errorSnippet: stripAnsiAndControl(String(meta.errorSnippet || "")).replace(/\s+/g, " ").trim().slice(0, 300),
      failures: (Number(prev?.failures) || 0) + 1,
      failedAt: new Date(now).toISOString(),
      cooldownUntil: now + ttlMs,
      ttlMs,
    };
    current.models[key] = nextEntry;
    writeHealthAtomic(healthPath, current);
    return { key, healthPath, ...nextEntry };
  });
}

function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function clearModelCooldown(targetKey, filePath) {
  const healthPath = resolveProviderHealthPath(filePath);
  if (!fs.existsSync(healthPath)) return { clearedCount: 0, remainingCount: 0, healthPath };
  return withFileLock(healthPath, () => {
    if (!fs.existsSync(healthPath)) return { clearedCount: 0, remainingCount: 0, healthPath };
    const raw = readRawHealthObject(healthPath);
    const keys = Object.keys(raw.models);
    if (keys.length === 0) return { clearedCount: 0, remainingCount: 0, healthPath };

    const query = typeof targetKey === "string" ? targetKey.trim().toLowerCase() : "";
    if (!query || query === "*") {
      writeHealthAtomic(healthPath, { version: 1, models: {} });
      return { clearedCount: keys.length, remainingCount: 0, healthPath };
    }

    const wildcardRe = query.includes("*") ? globToRegex(query) : null;
    let clearedCount = 0;
    const nextModels = {};
    for (const k of keys) {
      const kLow = k.toLowerCase();
      const matched = wildcardRe
        ? wildcardRe.test(kLow)
        : kLow === query || kLow.endsWith(`/${query}`);
      if (matched) clearedCount += 1;
      else nextModels[k] = raw.models[k];
    }
    if (clearedCount > 0) writeHealthAtomic(healthPath, { version: 1, models: nextModels });
    return { clearedCount, remainingCount: Object.keys(nextModels).length, healthPath };
  });
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

function hasExplicitNonPiBindingsOnly(obj) {
  return Boolean(
    obj?.bindings &&
      typeof obj.bindings === "object" &&
      Object.keys(obj.bindings).length > 0 &&
      !obj.bindings.pi,
  );
}

function collectSlotPiCandidates(slotObj, slotLabel, out) {
  if (!slotObj || typeof slotObj !== "object") return;
  const pushPair = (b, label, fallbackFamily = "") => {
    if (!b || typeof b !== "object") return;
    if (hasExplicitNonPiBindingsOnly(b)) return;
    const fam = typeof b.family === "string" && b.family.trim() ? b.family.trim().toLowerCase() : fallbackFamily;
    if (b.bindings?.pi) {
      pushPair(b.bindings.pi, label, fam);
      return;
    }
    const p =
      typeof b.providerInstanceId === "string"
        ? b.providerInstanceId.trim()
        : typeof b.provider === "string"
          ? b.provider.trim()
          : "";
    const m = typeof b.model === "string" ? b.model.trim() : "";
    if (p && m) out.push({ provider: p, model: m, family: fam || "", slotLabel: label });
    if (b.prefer) pushPair(b.prefer, `${label}.prefer`, fam);
    if (b.backup) pushPair(b.backup, `${label}.backup`, fam);
  };

  if (slotObj.bindings?.pi) {
    pushPair(slotObj.bindings.pi, slotLabel, typeof slotObj.family === "string" ? slotObj.family.trim().toLowerCase() : "");
  } else if (!hasExplicitNonPiBindingsOnly(slotObj)) {
    const slotFam = typeof slotObj.family === "string" ? slotObj.family.trim().toLowerCase() : "";
    if (slotObj.prefer) pushPair(slotObj.prefer, `${slotLabel}.prefer`, slotFam);
    if (slotObj.backup) pushPair(slotObj.backup, `${slotLabel}.backup`, slotFam);
    if (!slotObj.prefer && !slotObj.backup && (slotObj.providerInstanceId || slotObj.provider) && slotObj.model) {
      pushPair(slotObj, slotLabel, slotFam);
    }
  }
}

export function mapRoleToSlotName(role) {
  const r = String(role || "").trim().toLowerCase();
  if (r === "fast" || r === "scout") return "fast";
  if (r === "adversary" || r === "reviewer" || r === "judge" || r.startsWith("reviewer.")) return "adversary";
  return "workhorse";
}

export function isPiSingleFamilyConfig(configPath) {
  const cfgPath =
    typeof configPath === "string" && configPath.trim()
      ? path.resolve(configPath.trim())
      : process.env.ZEE_CONFIG_PATH?.trim()
        ? path.resolve(process.env.ZEE_CONFIG_PATH.trim())
        : path.join(os.homedir(), ".agents", "zee-config.json");
  if (!fs.existsSync(cfgPath)) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return Boolean(cfg?.harnesses?.pi?.singleFamily || cfg?.singleFamily);
  } catch {
    return false;
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

  const r = String(role || "").trim().toLowerCase();
  const targetSlot = mapRoleToSlotName(r);
  const allowSingleFamily = Boolean(cfg?.harnesses?.pi?.singleFamily || cfg?.singleFamily);
  const candidates = [];

  // Schema v3: 优先读取 harnesses.pi.slots，再兼容 legacy cfg.slots { fast, workhorse, adversary }
  const piSlotSources = [];
  if (cfg?.harnesses?.pi?.slots && typeof cfg.harnesses.pi.slots === "object") {
    piSlotSources.push({ prefix: "harnesses.pi.slots", slots: cfg.harnesses.pi.slots });
  }
  if (cfg?.slots && typeof cfg.slots === "object") {
    piSlotSources.push({ prefix: "slots", slots: cfg.slots });
  }
  for (const { prefix, slots } of piSlotSources) {
    if (slots[targetSlot]) collectSlotPiCandidates(slots[targetSlot], `${prefix}.${targetSlot}`, candidates);
    if (targetSlot === "adversary") {
      if (slots.workhorse) collectSlotPiCandidates(slots.workhorse, `${prefix}.workhorse`, candidates);
      if (slots.fast) collectSlotPiCandidates(slots.fast, `${prefix}.fast`, candidates);
    } else if (targetSlot === "workhorse") {
      if (slots.adversary) collectSlotPiCandidates(slots.adversary, `${prefix}.adversary`, candidates);
    } else if (targetSlot === "fast") {
      if (slots.workhorse) collectSlotPiCandidates(slots.workhorse, `${prefix}.workhorse`, candidates);
    }
  }

  // Legacy Schema v2 compat: cfg.roles
  const roles = cfg?.roles;
  if (roles && typeof roles === "object") {
    if (r === "reviewer" || r === "adversary" || r.startsWith("reviewer.")) {
      if (Array.isArray(roles.reviewers)) roles.reviewers.forEach((rev, i) => collectSlotPiCandidates(rev, `reviewers[${i}]`, candidates));
    } else if (r === "judge") {
      if (Array.isArray(roles.judge)) roles.judge.forEach((j, i) => collectSlotPiCandidates(j, `judge[${i}]`, candidates));
      else if (roles.judge) collectSlotPiCandidates(roles.judge, "judge", candidates);
      if (Array.isArray(roles.reviewers)) roles.reviewers.forEach((rev, i) => collectSlotPiCandidates(rev, `reviewers[${i}]`, candidates));
    } else if (r === "scout" || r === "verifier") {
      collectSlotPiCandidates(roles[r], r, candidates);
    } else if (r === "architect") {
      collectSlotPiCandidates(roles.architect?.primary, "architect.primary", candidates);
    } else if (r === "coder" || r === "ui") {
      collectSlotPiCandidates(roles[r]?.standard, `${r}.standard`, candidates);
      collectSlotPiCandidates(roles[r]?.heavy, `${r}.heavy`, candidates);
    } else if (roles[r]) {
      collectSlotPiCandidates(roles[r], r, candidates);
    }
  }

  const failedKey = makeModelHealthKey(failedProvider, failedModel);
  const failedModelKey = makeModelHealthKey(undefined, failedModel);
  const authFam = authorFamily ? extractModelFamily(authorFamily) : "";
  const needsCrossFamily = targetSlot === "adversary";
  const seen = new Set();

  for (const cand of candidates) {
    const candKey = makeModelHealthKey(cand.provider, cand.model);
    if (!candKey || seen.has(candKey)) continue;
    seen.add(candKey);

    if (candKey === failedKey) continue;
    if (!failedProvider && failedModelKey && cand.model.trim().toLowerCase() === failedModelKey) continue;

    const fam = cand.family ? extractModelFamily(cand.family) || cand.family : extractModelFamily(cand.model);
    if (needsCrossFamily && !allowSingleFamily && authFam && fam && fam === authFam) continue;

    if (getModelCooldown(cand.provider, cand.model, now, healthPath).active) continue;
    return { provider: cand.provider, model: cand.model, family: fam, slotLabel: cand.slotLabel };
  }

  return null;
}
