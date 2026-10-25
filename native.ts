/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ConnectSrc, CspPolicies } from "@main/csp";
import { randomBytes } from "crypto";
import { IpcMainInvokeEvent } from "electron";

CspPolicies["*.discordsays.com"] = ConnectSrc;
CspPolicies["https://*.discordsays.com"] = ConnectSrc;
CspPolicies["wss://*.discordsays.com"] = ConnectSrc;

const DEFAULT_UNIVERSE_ID = "78a74ba6-b027-4b0e-a686-9a6f4124c068";
const DEFAULT_ARISE_CLIENT = "spades-prod-main-4835c58";

/**
 * Exact implementation of Arise Engine `module "lDfAK"` `buildRequestId(bodyStr)`
 * Packs a 58-bit cryptographic nonce and a 64-bit tag (`FNV-1a(UTF8(bodyStr)) ^ SplitMix64(0x6c1fd93a84b7250en ^ (nonce + 0x9e3779b97f4a7c15n))`)
 * into the 122 non-version/non-variant bits of a UUIDv4 string (`4n << 76n | 2n << 62n`).
 */
function buildAriseRequestId(bodyStr?: string): string {
    const mask64 = (1n << 64n) - 1n;
    const bitPositions: bigint[] = [];
    for (let b = 127; b >= 0; b--) {
        if (b !== 79 && b !== 78 && b !== 77 && b !== 76 && b !== 63 && b !== 62) {
            bitPositions.push(BigInt(b));
        }
    }
    const randBits = (bits: number): bigint => {
        let v = 0n;
        const bytes = randomBytes(Math.ceil(bits / 8));
        for (const byte of bytes) v = (v << 8n) | BigInt(byte);
        return v & ((1n << BigInt(bits)) - 1n);
    };
    const nonce58 = randBits(58);
    let tag64: bigint;
    if (bodyStr === undefined) {
        tag64 = randBits(64);
    } else {
        let fnv = 0xcbf29ce484222325n;
        for (const byte of Buffer.from(bodyStr, "utf8")) {
            fnv = ((fnv ^ BigInt(byte)) * 1099511628211n) & mask64;
        }
        let sm = (0x6c1fd93a84b7250en ^ ((nonce58 + 0x9e3779b97f4a7c15n) & mask64)) & mask64;
        sm = ((sm ^ (sm >> 30n)) * 0xbf58476d1ce4e5b9n) & mask64;
        sm = ((sm ^ (sm >> 27n)) * 0x94d049bb133111ebn) & mask64;
        sm = (sm ^ (sm >> 31n)) & mask64;
        tag64 = (fnv ^ sm) & mask64;
    }
    const combined122 = (nonce58 << 64n) | tag64;
    let uuidInt = (4n << 76n) | (2n << 62n);
    for (let i = 0; i < 122; i++) {
        uuidInt |= ((combined122 >> BigInt(121 - i)) & 1n) << bitPositions[i];
    }
    const hex = uuidInt.toString(16).padStart(32, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function discoverAriseMetadata(baseOrigin: string): Promise<{ universeId: string; appVersion: string }> {
    let universeId = DEFAULT_UNIVERSE_ID;
    let appVersion = DEFAULT_ARISE_CLIENT;
    try {
        const htmlRes = await fetch(`${baseOrigin}/`, {
            method: "GET",
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(8000)
        });
        if (!htmlRes.ok) return { universeId, appVersion };
        const html = await htmlRes.text();
        const scriptMatch = html.match(/src=["']?(\/arise-frontend\.[^"'\s>]+\.js)["'\s>]/i);
        if (!scriptMatch?.[1]) return { universeId, appVersion };

        const jsRes = await fetch(`${baseOrigin}${scriptMatch[1]}`, {
            method: "GET",
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(10000)
        });
        if (!jsRes.ok) return { universeId, appVersion };
        const js = await jsRes.text();

        const univMatch =
            js.match(/["']X-Universe-ID["']\s*:\s*["']([0-9a-f-]{36})["']/i) ??
            js.match(/ARISE_UNIVERSEID["']\)\s*\|\|\s*["']([0-9a-f-]{36})["']/i);
        if (univMatch?.[1]) {
            universeId = univMatch[1];
        }

        const verMatch = js.match(/let\s+\w+=["']([0-9a-f]{6,12})["'],\s*\w+=["']([a-z0-9-]+)["']/i);
        if (verMatch?.[1] && verMatch?.[2]) {
            appVersion = `${verMatch[2]}-${verMatch[1]}`;
        }
    } catch {}
    return { universeId, appVersion };
}

export async function completeActivityQuest(
    _: IpcMainInvokeEvent,
    applicationId: string,
    questId: string,
    oauthCode: string,
    target = 1
): Promise<{ ok: boolean; status?: number; message?: string; step?: string }> {
    if (!applicationId || !/^\d+$/.test(String(applicationId))) {
        return { ok: false, message: "Invalid applicationId", step: "validate" };
    }
    if (!questId || !/^\d+$/.test(String(questId))) {
        return { ok: false, message: "Invalid questId", step: "validate" };
    }
    if (!oauthCode || typeof oauthCode !== "string") {
        return { ok: false, message: "Missing OAuth2 authorization code", step: "validate" };
    }

    const appIdStr = String(applicationId);
    const questIdStr = String(questId);
    const baseOrigin = `https://${appIdStr}.discordsays.com`;
    const { universeId, appVersion } = await discoverAriseMetadata(baseOrigin);

    const buildHeaders = (token = "", extra: Record<string, string> = {}) => ({
        "Content-Type": "application/json",
        "Accept": "*/*",
        "X-Auth-Token": token,
        "X-Universe-ID": universeId,
        "X-Discord-Activity-Id": appIdStr,
        "X-Discord-Hostname": `${appIdStr}.discordsays.com`,
        "X-Arise-Client": appVersion,
        "Origin": baseOrigin,
        "Referer": `${baseOrigin}/`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9265 Chrome/148.0.7778.280 Electron/42.11.15 Safari/537.36",
        ...extra
    });

    try {
        // 1. Exchange Discord OAuth2 code at /.proxy/acf/authorize
        const authRes = await fetch(`${baseOrigin}/.proxy/acf/authorize`, {
            method: "POST",
            headers: buildHeaders(""),
            body: JSON.stringify({ code: oauthCode, activityId: appIdStr }),
            signal: AbortSignal.timeout(12000)
        });
        const authText = await authRes.text();
        let authData: any = null;
        try {
            authData = JSON.parse(authText);
        } catch {}

        const acfToken: string = authData?.token || authData?.authToken || "";
        if (!authRes.ok || !acfToken) {
            return {
                ok: false,
                status: authRes.status,
                message: authData?.message || authText || "Failed to authorize with Activity backend",
                step: "authorize"
            };
        }

        // 2. Register with Arise backend (/.proxy/acf/arise/register) to obtain Arise session JWT
        let ariseToken = acfToken;
        try {
            const regRes = await fetch(`${baseOrigin}/.proxy/acf/arise/register`, {
                method: "POST",
                headers: buildHeaders(acfToken),
                signal: AbortSignal.timeout(10000)
            });
            if (regRes.ok) {
                const regData: any = await regRes.json().catch(() => null);
                if (regData?.authToken) {
                    ariseToken = regData.authToken;
                }
            }
        } catch {}

        // 3. Record title & mission completion on Arise API using exact module "lDfAK" X-Request-Id MAC
        try {
            const titleBody = JSON.stringify({ id: "f0rsaken-ace" });
            await fetch(`${baseOrigin}/.proxy/api/profileTitle/add`, {
                method: "POST",
                headers: buildHeaders(ariseToken, { "X-Request-Id": buildAriseRequestId(titleBody) }),
                body: titleBody,
                signal: AbortSignal.timeout(8000)
            }).catch(() => null);

            await fetch(`${baseOrigin}/.proxy/api/profile/mission-completed`, {
                method: "POST",
                headers: buildHeaders(ariseToken, { "X-Request-Id": buildAriseRequestId(undefined) }),
                body: undefined,
                signal: AbortSignal.timeout(8000)
            }).catch(() => null);
        } catch {}

        // 4. Submit quest completion progress to /.proxy/acf/quest/progress
        const progressValue = Math.max(1, Number(target) || 1);
        const progRes = await fetch(`${baseOrigin}/.proxy/acf/quest/progress`, {
            method: "POST",
            headers: buildHeaders(acfToken),
            body: JSON.stringify({ progress: progressValue, quest_id: questIdStr }),
            signal: AbortSignal.timeout(12000)
        });
        const progText = await progRes.text();
        let progData: any = null;
        try {
            progData = JSON.parse(progText);
        } catch {}

        const ok = progRes.ok && (progData?.status === "ok" || progData?.success !== false);
        return {
            ok,
            status: progRes.status,
            message: progData?.message || progData?.status || progText,
            step: "progress"
        };
    } catch (err: any) {
        return {
            ok: false,
            message: String(err?.message || err),
            step: "exception"
        };
    }
}
