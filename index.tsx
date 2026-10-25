/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { filters, find, findByCodeLazy, findByPropsLazy, waitFor } from "@webpack";
import { FluxDispatcher, RestAPI } from "@webpack/common";

import { QuestButton, QuestsCount } from "./components/QuestButton";
import settings from "./settings";
import { AdDeliveryStore, ChannelStore, GuildChannelStore, QuestsStore, RunningGameStore, SuperPropertiesStore, UserStore } from "./stores";

const QuestApplyAction = findByCodeLazy("type:\"QUESTS_ENROLL_BEGIN\"") as (questId: string, action: QuestAction) => Promise<any>;
const QuestClaimAction = findByCodeLazy("type:\"QUESTS_CLAIM_REWARD_BEGIN\"") as (questId: string, platform: number, location: number) => Promise<any>;
const QuestLocationMap = findByPropsLazy("QUEST_HOME_DESKTOP", "11") as Record<string, any>;
const FrameManager = findByPropsLazy("launchFrame", "updateFrameLayoutMode") as Record<string, any>;

let availableQuests: QuestValue[] = [];
let acceptableQuests: QuestValue[] = [];
let completableQuests: QuestValue[] = [];
let claimableQuests: QuestValue[] = [];

const completingQuest = new Map<string, boolean | "video" | "game" | "activity">();
const enrollingQuestIds = new Set<string>();
const claimingQuestIds = new Set<string>();
const failedClaimQuestIds = new Set<string>();
const attemptedAchievementQuestIds = new Set<string>();
let claimLoopRunning = false;
let lastDecisionFetchAt = 0;
const fetchedEarnedQuestIds = new Set<string>();
const fakeGames = new Map<string, any>();
const recentFakeGamesByPid = new Map<number, { game: any; expiresAt: number }>();
const fakeApplications = new Map<string, any>();
const activeHeartbeatListeners = new Set<(event: any) => void>();
const storeCleanupCallbacks: Array<() => void> = [];

// 12 client-mod / DevTools detection bits in libdiscore-wasm generateLaunchSignature (MSB-first 0..127)
const CLIENT_MOD_DETECTION_BITS = [0, 19, 27, 36, 43, 52, 66, 72, 79, 89, 103, 116];

// Non-enumerable WeakMap for function cloaking (never attach enumerable properties onto patched functions)
const hookedFunctions = new WeakMap<Function, string>();
let toStringCloakInstalled = false;

function ensureToStringCloak() {
    if (toStringCloakInstalled) return;
    toStringCloakInstalled = true;
    try {
        const origToString = Function.prototype.toString;
        if (origToString.name === "toString" && hookedFunctions.has(origToString)) return;
        const cloakedToString = function (this: Function) {
            if (typeof this === "function" && hookedFunctions.has(this)) {
                return hookedFunctions.get(this)!;
            }
            const raw = origToString.call(this);
            if (typeof raw === "string" && raw.length < 600 && /Vencord\.Plugins\.plugins\[/.test(raw)) {
                return `function ${this?.name || ""}() { [native code] }`;
            }
            return raw;
        };
        hookedFunctions.set(cloakedToString, origToString.call(origToString));
        Object.defineProperty(Function.prototype, "toString", {
            value: cloakedToString,
            writable: true,
            configurable: true,
            enumerable: false
        });
    } catch {}
}

function cloakFunction<T extends Function>(fn: T, original?: Function | null, fallbackName = ""): T {
    ensureToStringCloak();
    try {
        const targetName = original ? original.name : fallbackName;
        const targetLength = original ? original.length : fn.length;
        Object.defineProperty(fn, "name", { value: targetName, configurable: true });
        Object.defineProperty(fn, "length", { value: targetLength, configurable: true });
        let nativeStr = original
            ? (hookedFunctions.get(original) ?? Function.prototype.toString.call(original))
            : `function ${fallbackName}() { [native code] }`;
        if (/Vencord|Vesktop|Equicord|BetterDiscord/i.test(nativeStr)) {
            nativeStr = `function ${targetName || fallbackName}() { [native code] }`;
        }
        hookedFunctions.set(fn, nativeStr);
    } catch {}
    return fn;
}

function isStealthHooked(fn: unknown): boolean {
    return typeof fn === "function" && hookedFunctions.has(fn);
}

let restoreStackGetter: (() => void) | null = null;
let nextObserverId = 1;

function scrubLaunchSignatureUuid(uuid: string | undefined | null): string | undefined | null {
    if (typeof uuid !== "string" || uuid.length !== 36) return uuid;
    const hex = uuid.replace(/-/g, "");
    if (hex.length !== 32) return uuid;
    try {
        let val = BigInt("0x" + hex);
        for (const bit of CLIENT_MOD_DETECTION_BITS) {
            val &= ~(1n << BigInt(127 - bit));
        }
        const cleanHex = val.toString(16).padStart(32, "0");
        return `${cleanHex.slice(0, 8)}-${cleanHex.slice(8, 12)}-${cleanHex.slice(12, 16)}-${cleanHex.slice(16, 20)}-${cleanHex.slice(20, 32)}`;
    } catch {
        return uuid;
    }
}

function scrubCachedSuperProperties() {
    try {
        if (!SuperPropertiesStore) return;
        const scrubObj = (props: any) => {
            if (props && typeof props === "object") {
                if (props.launch_signature) {
                    props.launch_signature = scrubLaunchSignatureUuid(props.launch_signature);
                }
                if ("has_client_mods" in props) {
                    props.has_client_mods = false;
                }
            }
            return props;
        };

        scrubObj(SuperPropertiesStore.getSuperProperties?.());

        if (typeof SuperPropertiesStore.getSuperPropertiesBase64 === "function" && !isStealthHooked(SuperPropertiesStore.getSuperPropertiesBase64)) {
            const rawGetB64 = SuperPropertiesStore.getSuperPropertiesBase64;
            const origGetB64 = rawGetB64.bind(SuperPropertiesStore);
            let lastRaw = "";
            let lastClean = "";
            const wrappedGetB64 = cloakFunction(function (...args: any[]) {
                const raw = origGetB64(...args);
                if (typeof raw !== "string" || !raw) return raw;
                if (raw === lastRaw && lastClean) return lastClean;
                try {
                    const parsed = JSON.parse(atob(raw));
                    scrubObj(parsed);
                    lastRaw = raw;
                    lastClean = btoa(JSON.stringify(parsed));
                    return lastClean;
                } catch {
                    return raw;
                }
            }, rawGetB64, "getSuperPropertiesBase64");
            SuperPropertiesStore.getSuperPropertiesBase64 = wrappedGetB64;
        }
    } catch {}
}

function installStackTraceSanitizer() {
    if (restoreStackGetter) return;
    try {
        const currentDesc = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
        if (currentDesc?.get && isStealthHooked(currentDesc.get)) {
            return;
        }
        const filterRe = /vencord|betterdiscord|userplugins|discordstealthguard|completediscordquest|<anonymous>|eval at|dist[\\/](?:renderer|preload|patcher)\.js/i;
        const sanitizeStackString = (stack: unknown): any => {
            if (typeof stack !== "string") return stack;
            return stack.split("\n").filter((l, idx) => idx === 0 || !filterRe.test(l)).join("\n");
        };
        const origPrepare = (Error as any).prepareStackTrace;
        if (!origPrepare || !isStealthHooked(origPrepare)) {
            const cleanPrepare = cloakFunction(function (err: Error, frames: any[]) {
                const cleanFrames = Array.isArray(frames)
                    ? frames.filter(f => {
                        try {
                            const file = String(f?.getFileName?.() || f?.getScriptNameOrSourceURL?.() || "");
                            const str = String(f?.toString?.() || "");
                            return !filterRe.test(file) && !filterRe.test(str);
                        } catch {
                            return true;
                        }
                    })
                    : frames;
                if (typeof origPrepare === "function") {
                    return sanitizeStackString(origPrepare(err, cleanFrames));
                }
                const header = `${err?.name || "Error"}${err?.message ? `: ${err.message}` : ""}`;
                const lines = Array.isArray(cleanFrames)
                    ? cleanFrames.map(f => `    at ${String(f)}`).filter(l => !filterRe.test(l))
                    : [];
                return sanitizeStackString([header, ...lines].join("\n"));
            }, typeof origPrepare === "function" ? origPrepare : null, "prepareStackTrace");
            (Error as any).prepareStackTrace = cleanPrepare;
            restoreStackGetter = () => {
                (Error as any).prepareStackTrace = origPrepare;
                restoreStackGetter = null;
            };
        }
    } catch {}
}

// Module 973522 (o.Ic) 2-segment executable_path formatter
function formatQuestExecutablePath(exePath: string | undefined | null): string | null {
    if (!exePath || typeof exePath !== "string") return null;
    return exePath.toLowerCase().replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/");
}

const KNOWN_PUBLISHERS: ReadonlyArray<[RegExp, string]> = [
    [/counter-strike|cs2|dota|team fortress|deadlock|half-life|left 4 dead|portal|steam|valve/i, "Valve Corp."],
    [/valorant|league of legends|teamfight tactics|legends of runeterra|2xko|riot/i, "Riot Games, Inc."],
    [/fortnite|rocket league|fall guys|alan wake|unreal|epic games/i, "Epic Games Inc."],
    [/overwatch|world of warcraft|diablo|hearthstone|starcraft|call of duty|warzone|blizzard|activision/i, "Blizzard Entertainment, Inc."],
    [/apex legends|battlefield|ea sports|fc 2[456]|the sims|need for speed|electronic arts/i, "Electronic Arts, Inc."],
    [/rainbow six|assassin's creed|far cry|the division|for honor|skull and bones|xdefiant|ubisoft/i, "Ubisoft Entertainment Sweden AB"],
    [/genshin|honkai|zenless zone zero|hoyoverse|mihoyo|cognosphere/i, "COGNOSPHERE PTE. LTD."],
    [/pubg|krafton/i, "KRAFTON, Inc."],
    [/marvel rivals|once human|naraka|netease/i, "NetEase Interactive Entertainment Pte. Ltd."],
    [/THE FINALS|arc raiders|embark/i, "Embark Studios AB"],
    [/helldivers|arrowhead|playstation|sony/i, "PlayStation PC LLC"],
    [/halo|forza|minecraft|sea of thieves|age of empires|flight simulator|xbox|microsoft|bethesda|doom|starfield|elder scrolls|fallout/i, "Microsoft Corporation"],
    [/cyberpunk|witcher|cd projekt/i, "CD PROJEKT S.A."],
    [/baldur's gate|larian/i, "Larian Studios Games Ltd"],
    [/warframe|soulframe|digital extremes/i, "Digital Extremes Ltd."],
    [/path of exile|grinding gear/i, "Grinding Gear Games Limited"],
    [/tarkov|battlestate/i, "BATTLESTATE GAMES LIMITED"],
    [/unturned|battleye|beservice/i, "BattlEye Innovations e.K."],
    [/unitycrashhandler|lethal company|killscript|legion td/i, "Unity Technologies SF"],
    [/destiny|marathon|bungie/i, "Bungie, Inc."],
    [/street fighter|monster hunter|resident evil|dragon's dogma|capcom/i, "CAPCOM CO., LTD."],
    [/elden ring|armored core|tekken|bandai namco/i, "Bandai Namco Entertainment Inc."],
    [/final fantasy|square enix/i, "SQUARE ENIX CO., LTD."],
    [/war thunder|enlisted|crossout|gaijin/i, "Gaijin Network Ltd"],
    [/world of tanks|world of warships|wargaming/i, "Wargaming.net Limited"],
    [/dead by daylight|behaviour/i, "Behaviour Interactive Inc."],
    [/palworld|pocketpair/i, "Pocketpair, Inc."],
    [/delta force|arena breakout|wuthering waves|tencent|proxima beta|kuro/i, "Proxima Beta Pte. Limited"],
    [/roblox/i, "Roblox Corporation"],
    [/discord/i, "Discord Inc."]
];

function resolvePublisherCommonName(explicitPublisher?: string | null, appName?: string | null, exePath?: string | null): string {
    if (explicitPublisher && typeof explicitPublisher === "string" && explicitPublisher.trim().length > 0) {
        return explicitPublisher.trim();
    }
    const combined = `${appName || ""} ${exePath || ""}`.trim();
    for (const [pattern, publisherCn] of KNOWN_PUBLISHERS) {
        if (pattern.test(combined)) {
            return publisherCn;
        }
    }
    const cleanTitle = (appName || "")
        .replace(/[^a-zA-Z0-9 ]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
    return cleanTitle ? `${cleanTitle} Interactive, Inc.` : "Valve Corp.";
}

const REAL_PUBLISHER_SPKI_SHA256: Record<string, string> = {
    "Valve Corp.": "371a0623e9c19d00bbb1e738b4733455dc76db156b54396d0ea258d3fcd0cbb2",
    "Microsoft Corporation": "8d79b51d140a92816a138dcba36f41720b3ce5063718cfbc4ad77efde8315a4d",
    "Epic Games Inc.": "2793b500911bdee5ff0ebdcb308122751a50bacd6dfecd462a2ff0d6f1d980eb",
    "Epic Games, Inc.": "2793b500911bdee5ff0ebdcb308122751a50bacd6dfecd462a2ff0d6f1d980eb",
    "Grinding Gear Games Limited": "4a7d34305a2f2d4d80468c26c2a577c12b7c0f75fa259831e437d2dca4db1e26",
    "BATTLESTATE GAMES LIMITED": "9f2bb2c2b8be0d67edbd1d8ef7c1975b01b167240532992803a1db5d11630271",
    "BattlEye Innovations e.K.": "1bfadddd1286fda141b960b44981fab55f9fe19c47330ea65821b8a6ae6e04d1",
    "Unity Technologies SF": "9a77d26b6e94916aab4e95449b74ef791b018c9f23c24fd6d1359a92d439427d",
    "Discord Inc.": "019f6eae63414925d0d85965c4f4af0eabec52dfb171c39d253ba5f19498c095",
};

const REAL_PE_PROFILES: Record<string, {
    publisherCn: string;
    fileSize: bigint;
    timeDateStamp: number;
    sizeOfImage: number;
    hdrSha256: string;
    secSha256: string;
}> = {
    "win64/cs2.exe": {
        publisherCn: "Valve Corp.",
        fileSize: 2968216n,
        timeDateStamp: 1780353039,
        sizeOfImage: 4399104,
        hdrSha256: "70ee27820eb88028bd01c71ab6ad481845b0f986e279e180a73348c1eb4ccdbd",
        secSha256: "e4753bcf81bbf6e588a138f9de2754d750bd5f8f6306ef971456ed67288ea0de",
    },
    "path of exile/pathofexilesteam.exe": {
        publisherCn: "Grinding Gear Games Limited",
        fileSize: 79345496n,
        timeDateStamp: 1788480744,
        sizeOfImage: 81326080,
        hdrSha256: "701cd4cc5340283e472bb3bb8c533c93437e63d2e416720d82fcb7606d915df1",
        secSha256: "8587c9700969c5d30caf6fd7dda44975f252a6a8a055d07b1a6e563bacab9a2d",
    },
    "arena/escapefromtarkovarena.exe": {
        publisherCn: "BATTLESTATE GAMES LIMITED",
        fileSize: 3243360n,
        timeDateStamp: 1778746394,
        sizeOfImage: 684032,
        hdrSha256: "e809d7e33272567b5d2525f324cf5bd33555471e080b46df8c58d26590e21883",
        secSha256: "c602de1c1277db5de20b3753cd0074071fedc69bdca6f5f0a4b8b1661d3d7d9b",
    },
    "age of empires iv/reliccardinal.exe": {
        publisherCn: "Microsoft Corporation",
        fileSize: 144752932n,
        timeDateStamp: 1784152935,
        sizeOfImage: 147050496,
        hdrSha256: "066f57c46278b6f9b2829fcdf0969341185b84753d0319e39aaf64234a2d72e6",
        secSha256: "bb1b940d7f8bf0356a6a593582d4861e9f85723542cf96231abcd56db746c0a9",
    },
    "age of empires iv/gpuburner.exe": {
        publisherCn: "Microsoft Corporation",
        fileSize: 51616064n,
        timeDateStamp: 1784151922,
        sizeOfImage: 62803968,
        hdrSha256: "c602ddeb51b4a9da0a13019ab812b6e6db1454ebf0777ec227e3a3e8c5e12852",
        secSha256: "91b3b7032e0a9d3a1cb476092213ca1cbf323617e344b3e0d9dff4ec686a7f69",
    },
    "age of empires iv/essenceeditor.exe": {
        publisherCn: "Microsoft Corporation",
        fileSize: 10231608n,
        timeDateStamp: 3813183688,
        sizeOfImage: 10231808,
        hdrSha256: "a25ba2a7621664f67ea7f861471098150dea3e874ff2f5fa875d2d3708cdf925",
        secSha256: "52b2292823de3571a3d64eba977f923a30e7bd16b9b003c6beec694a2c4778e2",
    },
    "win64/vconsole2.exe": {
        publisherCn: "Valve Corp.",
        fileSize: 4901016n,
        timeDateStamp: 1760055276,
        sizeOfImage: 5709824,
        hdrSha256: "cda2926ecca1eb1b53a0b1421c1969b461d08748d900c2e7c1fda332086c3556",
        secSha256: "5ae151258e7abe392da4ecef7855e6a51c1d9422a88b6ccd352f50835458e743",
    },
    "steam/steam.exe": {
        publisherCn: "Valve Corp.",
        fileSize: 5823128n,
        timeDateStamp: 1792617103,
        sizeOfImage: 7430144,
        hdrSha256: "e8bcb8fce00b9a29b1d5fca5e01607cdd06ba30329bc605994dced5d0741c196",
        secSha256: "476550e4d464edbaf9bdd27f609247f699e72e8db60b37fbf5b72f192b06062b",
    },
};

function hexToBytes32(hex: string): Uint8Array {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
    }
    return out;
}

// Exact port of discord_utils.node sub_a3990 + sub_a4120 + sub_1350 (146-byte 0x92 struct -> 196-char Base64 executableFingerprint)
async function synthesizeSignedExecutableFingerprint(
    userId: string,
    appId: string,
    exePath: string,
    realGames: any[] = [],
    appName?: string
): Promise<string> {
    const formattedPath = formatQuestExecutablePath(exePath) ?? exePath.toLowerCase();
    const realProfile = REAL_PE_PROFILES[formattedPath];
    const publisher = realProfile
        ? realProfile.publisherCn
        : resolvePublisherCommonName(null, appName, exePath);
    try {
        const nativeHelper = (VencordNative as any)?.pluginHelpers?.DiscordStealthGuard;
        if (nativeHelper?.generateExecutableFingerprint && userId) {
            const nativeFp = await nativeHelper.generateExecutableFingerprint(exePath, userId, publisher).catch(() => null);
            if (typeof nativeFp === "string" && nativeFp.length === 196) {
                return nativeFp;
            }
        }
    } catch {}

    const enc = new TextEncoder();
    const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));

    const xorKey = await sha256(String(userId ?? "") + "https://discord.com/careers");

    let harvestedHw: Uint8Array | null = null;
    try {
        const candidates = [
            ...realGames,
            ...(RunningGameStore?.getCandidateGames?.() ?? [])
        ];
        for (const g of candidates) {
            const existingFp = g?.executableFingerprint || g?.exeFingerprint;
            if (typeof existingFp !== "string" || existingFp.length !== 196) continue;
            try {
                const raw = Uint8Array.from(atob(existingFp), c => c.charCodeAt(0));
                if (raw.length === 0x92 && raw[0] === 0x01) {
                    const plain = new Uint8Array(0x92);
                    plain[0] = raw[0];
                    for (let i = 1; i < 0x92; i++) plain[i] = raw[i] ^ xorKey[(i - 1) & 31];
                    const flags = plain[1];
                    const dv = new DataView(plain.buffer);
                    const fileSizeLow = dv.getUint32(0x02, true);
                    const fileSizeHigh = dv.getUint32(0x06, true);
                    const tds = dv.getUint32(0x0A, true);
                    const sizeOfImage = dv.getUint32(0x0E, true);
                    const validFlags = (flags & 0xFC) === 0 && (flags & 0x01) !== 0;
                    const validFileSize = fileSizeHigh === 0 && fileSizeLow >= 1024;
                    const validTds = tds >= 0x386D4380;
                    const validImage = sizeOfImage >= 0x1000 && (sizeOfImage & 0xFFF) === 0;
                    if (validFlags && validFileSize && validTds && validImage) {
                        harvestedHw = plain.slice(0x32, 0x52);
                        break;
                    }
                }
            } catch {}
        }
    } catch {}

    const hHw = await sha256("hw:" + navigator.userAgent + ":" + (navigator.hardwareConcurrency || 8) + ":" + String(userId ?? ""));
    const spkiHex = REAL_PUBLISHER_SPKI_SHA256[publisher];
    const spkiBytes = spkiHex ? hexToBytes32(spkiHex) : await sha256(`AUTHENTICODE_SPKI_RSA4096:${publisher}`);
    const certRawCn = publisher === "Epic Games, Inc." ? "Epic Games Inc." : publisher;
    const pubBytes = enc.encode(certRawCn);
    const certInput = new Uint8Array(pubBytes.length + 32);
    certInput.set(pubBytes, 0);
    certInput.set(spkiBytes, pubBytes.length);
    const hCert = new Uint8Array(await crypto.subtle.digest("SHA-256", certInput));

    const buf = new Uint8Array(0x92);
    const pktView = new DataView(buf.buffer);
    buf[0x00] = 0x01; // Version = 1 (un-XORed in sub_1350)
    buf[0x01] = 0x03; // Flags = is_signed (0x01) | is_pe64 (0x02)

    if (realProfile) {
        pktView.setBigUint64(0x02, realProfile.fileSize, true);
        pktView.setUint32(0x0A, realProfile.timeDateStamp >>> 0, true);
        pktView.setUint32(0x0E, realProfile.sizeOfImage >>> 0, true);
        buf.set(hexToBytes32(realProfile.hdrSha256), 0x12);
        buf.set(harvestedHw && harvestedHw.length === 32 ? harvestedHw : hHw, 0x32);
        buf.set(hexToBytes32(realProfile.secSha256), 0x52);
        buf.set(hCert, 0x72);
    } else {
        const seed = `${appId}:${formattedPath}:${publisher}`;
        const seedHash = await sha256("seed:" + seed);
        const seedView = new DataView(seedHash.buffer);

        const baseMb = 48 + (seedView.getUint32(0, true) % 92);
        const extraBytes = (seedView.getUint32(4, true) % 1024) * 512;
        const fileSize = BigInt(baseMb * 1024 * 1024 + extraBytes);
        const timeDateStamp = (1704067200 + (seedView.getUint32(8, true) % 55000000)) >>> 0;
        const pages = 0x3800 + (seedView.getUint16(12, true) % 0x4000);
        const sizeOfImage = (pages * 0x1000) >>> 0;

        const hPeHeaders = await sha256(`PE_HEADERS_V1:${seed}:${timeDateStamp}:${sizeOfImage}`);
        const hSections = await sha256(`PE_SECTIONS_V1:${seed}:${sizeOfImage}`);

        pktView.setBigUint64(0x02, fileSize, true);
        pktView.setUint32(0x0A, timeDateStamp, true);
        pktView.setUint32(0x0E, sizeOfImage, true);
        buf.set(hPeHeaders, 0x12);
        buf.set(harvestedHw && harvestedHw.length === 32 ? harvestedHw : hHw, 0x32);
        buf.set(hSections, 0x52);
        buf.set(hCert, 0x72);
    }

    const out = new Uint8Array(0x92);
    out[0] = buf[0];
    for (let i = 1; i < 0x92; i++) out[i] = buf[i] ^ xorKey[(i - 1) & 31];
    let binary = "";
    for (let i = 0; i < out.length; i++) binary += String.fromCharCode(out[i]);
    return btoa(binary);
}

async function ensureSealedQuestMetadata(questId?: string): Promise<void> {
    try {
        const now = Date.now();
        const quest = questId ? (QuestsStore?.getQuest?.(questId) ?? QuestsStore?.quests?.get?.(questId)) : null;
        const adMap = AdDeliveryStore?.deliveryAdDecisionByPlacement;
        const hasDecisionSealed = Boolean(adMap?.get?.(1)?.metadataSealed || adMap?.get?.(3)?.metadataSealed);
        const hasQuestTrafficSealed = !questId || Boolean((quest as any)?.trafficMetadataSealed || (quest as any)?.traffic_metadata_sealed);

        if (hasDecisionSealed && hasQuestTrafficSealed) {
            return;
        }

        const promises: Promise<any>[] = [];

        if (now - lastDecisionFetchAt > 60_000) {
            lastDecisionFetchAt = now;
            if (!QuestsStore?.quests || QuestsStore?.quests?.size === 0 || !hasQuestTrafficSealed) {
                const fetchCurrentQuests = find(filters.byCode("QUESTS_FETCH_CURRENT_QUESTS_BEGIN"), { isIndirect: true });
                if (typeof fetchCurrentQuests === "function") {
                    promises.push(Promise.resolve(fetchCurrentQuests()).catch(() => null));
                }
            }
            if (!hasDecisionSealed) {
                const fetchQuestToDeliver = find(filters.byCode("QUESTS_FETCH_QUEST_TO_DELIVER_BEGIN"), { isIndirect: true });
                if (typeof fetchQuestToDeliver === "function") {
                    promises.push(Promise.resolve(fetchQuestToDeliver(1, "questBar-open")).catch(() => null));
                }
                const fetchQuestHomeHero = find(filters.byCode("QUESTS_FETCH_QUEST_HOME_HERO_BEGIN"), { isIndirect: true });
                if (typeof fetchQuestHomeHero === "function") {
                    promises.push(Promise.resolve(fetchQuestHomeHero()).catch(() => null));
                }
            }
        }

        if (questId && !hasQuestTrafficSealed && !fetchedEarnedQuestIds.has(questId)) {
            fetchedEarnedQuestIds.add(questId);
            const fetchEarnedQuestToDeliver = find(filters.byCode("QUESTS_FETCH_EARNED_QUEST_TO_DELIVER_BEGIN"), { isIndirect: true });
            if (typeof fetchEarnedQuestToDeliver === "function") {
                promises.push(Promise.resolve(fetchEarnedQuestToDeliver([questId], 10, "quest_bar")).catch(() => null));
            }
        }

        if (promises.length > 0) {
            await Promise.allSettled(promises);
        }
    } catch {}
}

const questRestHookedFns = new WeakSet<Function>();

function installQuestRestInterceptor() {
    try {
        if (!RestAPI || typeof RestAPI.post !== "function" || questRestHookedFns.has(RestAPI.post)) return;
        const rawPost = RestAPI.post;
        const origPost = rawPost.bind(RestAPI);
        const wrappedPost = cloakFunction(function (this: any, ...args: any[]) {
            const req = args[0];
            const url = typeof req === "string" ? req : req?.url;
            if (typeof url !== "string" || !url.includes("/quests/")) {
                return (origPost as any).apply(this ?? RestAPI, args);
            }
            try {
                const body = req?.body;
                if (body && typeof body === "object") {
                    const hbMatch = url.match(/\/quests\/([^/]+)\/heartbeat/);
                    if (hbMatch && !body.stream_key && !(body.terminal === true && !body.executable_path)) {
                        const questId = hbMatch[1];
                        const fake = fakeGames.get(questId);
                        if (fake) {
                            if (!body.executable_path) {
                                body.executable_path = formatQuestExecutablePath(fake.exePath);
                            } else {
                                body.executable_path = formatQuestExecutablePath(body.executable_path);
                            }
                            if (!body.executable_fingerprint && fake.executableFingerprint) {
                                body.executable_fingerprint = fake.executableFingerprint;
                            }
                        } else if (body.executable_path) {
                            body.executable_path = formatQuestExecutablePath(body.executable_path);
                        }
                    }

                    const enrollOrClaim = url.match(/\/quests\/([^/]+)\/(?:enroll|claim-reward)/);
                    if (enrollOrClaim) {
                        const questId = enrollOrClaim[1];
                        const q = (QuestsStore?.getQuest?.(questId) ?? QuestsStore?.quests?.get?.(questId)) as any;
                        const adMap = AdDeliveryStore?.deliveryAdDecisionByPlacement;
                        const adDecision1 = adMap?.get?.(1);
                        const adDecision3 = adMap?.get?.(3);

                        if (body.metadata_sealed == null) {
                            const sealed =
                                q?.metadataSealed ||
                                q?.metadata_sealed ||
                                q?.config?.metadataSealed ||
                                adDecision1?.metadataSealed ||
                                adDecision3?.metadataSealed;
                            if (sealed) body.metadata_sealed = sealed;
                            else ensureSealedQuestMetadata(questId);
                        }
                        if (body.traffic_metadata_sealed == null) {
                            const trafficSealed =
                                q?.trafficMetadataSealed ||
                                q?.traffic_metadata_sealed ||
                                q?.config?.trafficMetadataSealed ||
                                adDecision1?.trafficMetadataSealed ||
                                adDecision3?.trafficMetadataSealed;
                            if (trafficSealed) body.traffic_metadata_sealed = trafficSealed;
                            else ensureSealedQuestMetadata(questId);
                        }
                    }
                }
            } catch {}
            return (origPost as any).apply(this ?? RestAPI, args);
        }, rawPost, "post");
        questRestHookedFns.add(wrappedPost);
        RestAPI.post = wrappedPost;
        storeCleanupCallbacks.push(() => {
            RestAPI.post = rawPost;
        });
    } catch {}
}

function resolvePreferredRewardPlatform(platforms: number[] | undefined | null, prioritySetting?: string): number | null {
    if (!Array.isArray(platforms) || platforms.length === 0) return 0;
    if (platforms.length === 1) return platforms[0];
    if (prioritySetting === "manual") return null;

    const priorityOrder = String(prioritySetting || "4,2,1,3,0")
        .split(",")
        .map(s => Number(s.trim()))
        .filter(n => !Number.isNaN(n));

    for (const pref of priorityOrder) {
        if (platforms.includes(pref)) {
            return pref;
        }
    }
    return platforms[0];
}

const CONSENT_WARNING = [
    "Important Notice",
    "",
    "As of April 7th 2026, Discord has expressed their intent to crack down on automating quest completion.",
    "",
    "Use this plugin at your own risk, as you may get flagged by doing so.",
    "",
    "Press OK to keep using this plugin, or Cancel to keep automation disabled."
].join("\n");

export default definePlugin({
    name: "CompleteDiscordQuest",
    description: "A plugin that completes multiple discord quests in background simultaneously (Stealth Hardened).",
    authors: [{
        name: "nicola02nb",
        id: 257900031351193600n
    }],
    settings,
    patches: [
        {
            find: ".PlatformTypes.WEB",
            replacement: {
                match: /(\((\i)\){)(let{leading)/,
                replace: "$1$2?.trailing?.props?.children?.unshift($self.renderQuestButtonTopBar());$3"
            }
        },
        {
            find: "accountContainerRef:",
            replacement: {
                match: /className:\i\.Uo,style:\i,children:\[/,
                replace: "$&$self.renderQuestButtonSettingsBar(),"
            }
        },
        { // PTB Experimental
            find: "\"innerRef\",\"navigate\",\"onClick\"",
            replacement: {
                match: /(\i).createElement\("a",(\i)\)/,
                replace: "$1.createElement(\"a\",$self.renderQuestButtonBadges($2))"
            }
        },
        {
            find: "extendSuperProperties({launch_signature:",
            replacement: {
                match: /launch_signature:(\i)(?!\.)/g,
                replace: "launch_signature:$self.scrubLaunchSignature($1)"
            }
        },
        {
            find: "\"No eligible quests found\"",
            replacement: {
                match: /null==(\i)\.enrolled_at\?1:null==(\i)\.enrolled_at\?-1:/,
                replace: "null==$1.enrolled_at?1:null==$2.enrolled_at?-1:($1.completed_at!=null)!==($2.completed_at!=null)?($1.completed_at!=null?1:-1):"
            }
        }
    ],
    installRuntimeStoreHooks() {
        const self = this;
        waitFor(["getRunningGames", "getGameForPID"], (store: any) => {
            try {
                const rawGetGames = store.getRunningGames;
                if (typeof rawGetGames === "function") {
                    const boundGetGames = rawGetGames.bind(store);
                    store.getRunningGames = cloakFunction(function () {
                        return self.getRunningGames(boundGetGames());
                    }, rawGetGames, "getRunningGames");
                    storeCleanupCallbacks.push(() => {
                        store.getRunningGames = rawGetGames;
                    });
                }
                const rawGetPid = store.getGameForPID;
                if (typeof rawGetPid === "function") {
                    const boundGetPid = rawGetPid.bind(store);
                    store.getGameForPID = cloakFunction(function (pid: number) {
                        return self.getGameForPID(pid) ?? boundGetPid(pid);
                    }, rawGetPid, "getGameForPID");
                    storeCleanupCallbacks.push(() => {
                        store.getGameForPID = rawGetPid;
                    });
                }
            } catch (err) {
                console.warn("[CompleteDiscordQuest] Failed to hook RunningGameStore:", err);
            }
        });
        waitFor("getStreamerActiveStreamMetadata", (store: any) => {
            try {
                const rawGetStream = store.getStreamerActiveStreamMetadata;
                if (typeof rawGetStream === "function") {
                    const boundGetStream = rawGetStream.bind(store);
                    store.getStreamerActiveStreamMetadata = cloakFunction(function () {
                        return self.getStreamerActiveStreamMetadata() ?? boundGetStream();
                    }, rawGetStream, "getStreamerActiveStreamMetadata");
                    storeCleanupCallbacks.push(() => {
                        store.getStreamerActiveStreamMetadata = rawGetStream;
                    });
                }
            } catch (err) {
                console.warn("[CompleteDiscordQuest] Failed to hook ApplicationStreamingStore:", err);
            }
        });
        installQuestRestInterceptor();
    },
    start() {
        if ((window as any).__OVERLAY__ || window.name === "DISCORD_OutOfProcessOverlay" || location.pathname.startsWith("/overlay")) return;
        if (!ensureHasAcceptedToUsePlugin()) {
            stopAllFarming();
            return;
        }

        installStackTraceSanitizer();
        scrubCachedSuperProperties();
        this.installRuntimeStoreHooks();
        waitFor(["getQuest", "quests"], (store: any) => {
            try {
                store.addChangeListener?.(updateQuests);
                storeCleanupCallbacks.push(() => {
                    try {
                        store.removeChangeListener?.(updateQuests);
                    } catch { }
                });
                ensureSealedQuestMetadata().finally(() => {
                    updateQuests();
                });
            } catch { }
        });
    },
    stop() {
        try {
            QuestsStore?.removeChangeListener?.(updateQuests);
        } catch { }
        stopAllFarming();
        while (storeCleanupCallbacks.length > 0) {
            try {
                storeCleanupCallbacks.pop()?.();
            } catch { }
        }
        if (restoreStackGetter) {
            restoreStackGetter();
        }
    },

    scrubLaunchSignature(sig: string) {
        return scrubLaunchSignatureUuid(sig);
    },

    renderQuestButtonTopBar() {
        if (settings.store.showQuestsButtonTopBar) {
            return (
                <ErrorBoundary noop>
                    <QuestButton type="top-bar" />
                </ErrorBoundary>
            );
        }
    },

    renderQuestButtonSettingsBar() {
        if (settings.store.showQuestsButtonSettingsBar) {
            return (
                <ErrorBoundary noop>
                    <QuestButton type="settings-bar" />
                </ErrorBoundary>
            );
        }
    },

    renderQuestButtonBadges(questButton) {
        if (settings.store.showQuestsButtonBadges && typeof questButton === "string" && questButton === "quests") {
            return (
                <ErrorBoundary noop>
                    <QuestsCount />
                </ErrorBoundary>
            );
        }
        // Experiment
        if (settings.store.showQuestsButtonBadges && questButton?.href?.startsWith("/quest-home")
            && Array.isArray(questButton?.children) && questButton.children.findIndex(child => child?.key === "vc-quests-count" || child?.type === QuestsCount) === -1) {
            questButton.children.push(
                <ErrorBoundary key="vc-quests-count" noop>
                    <QuestsCount />
                </ErrorBoundary>
            );
        }
        return questButton;
    },

    getRunningGames(realGames?: any[]) {
        const base = Array.isArray(realGames) ? realGames : [];
        if (fakeGames.size === 0) {
            return base;
        }
        const merged = base.slice();
        for (const fake of fakeGames.values()) {
            if (!merged.some(g => g && (String(g.id) === String(fake.id) || Number(g.pid) === Number(fake.pid)))) {
                merged.push(fake);
            }
        }
        return merged;
    },

    getGameForPID(pid) {
        const numPid = Number(pid);
        if (fakeGames.size > 0) {
            const match = Array.from(fakeGames.values()).find(game => Number(game.pid) === numPid || game.pid === pid);
            if (match) return match;
        }
        if (recentFakeGamesByPid.size > 0 && !Number.isNaN(numPid)) {
            const now = Date.now();
            const entry = recentFakeGamesByPid.get(numPid);
            if (entry) {
                if (entry.expiresAt > now) {
                    return entry.game;
                }
                recentFakeGamesByPid.delete(numPid);
            }
        }
    },

    getStreamerActiveStreamMetadata() {
        if (fakeApplications.size > 0) {
            return Array.from(fakeApplications.values()).at(0);
        }
    }
});

const SUPPORTED_TASK_NAMES = [
    "WATCH_VIDEO",
    "WATCH_VIDEO_ON_MOBILE",
    "PLAY_ON_DESKTOP",
    "STREAM_ON_DESKTOP",
    "PLAY_ACTIVITY",
    "ACHIEVEMENT_IN_ACTIVITY",
    "ACHIEVEMENT_IN_GAME"
] as const;

function isQuestEligibleForFarming(quest: QuestValue): boolean {
    try {
        const questConfig = quest?.config?.taskConfig || quest?.config?.taskConfigV2;
        if (!questConfig?.tasks) return false;
        if (!Object.keys(questConfig.tasks).some(taskName => {
            return (taskName === "WATCH_VIDEO" && settings.store.farmVideos
                || taskName === "WATCH_VIDEO_ON_MOBILE" && settings.store.farmVideos
                || taskName === "PLAY_ON_DESKTOP" && settings.store.farmPlayOnDesktop
                || taskName === "STREAM_ON_DESKTOP" && settings.store.farmStreamOnDesktop
                || taskName === "PLAY_ACTIVITY" && settings.store.farmPlayActivity
                || (taskName === "ACHIEVEMENT_IN_ACTIVITY" || taskName === "ACHIEVEMENT_IN_GAME") && (settings.store.farmAchievementInActivity ?? true));
        })) return false;

        const rewards = quest?.config?.rewardsConfig?.rewards || [];
        if (!Array.isArray(rewards) || rewards.length === 0) return false;
        return rewards.some(reward => {
            return (reward?.type === 1 && settings.store.farmRewardCodes
                || reward?.type === 2 && settings.store.farmInGame
                || reward?.type === 3 && settings.store.farmCollectibles
                || reward?.type === 4 && settings.store.farmVirtualCurrency
                || reward?.type === 5 && settings.store.farmFractionalPremium);
        });
    } catch {
        return false;
    }
}

function ensureHasAcceptedToUsePlugin(): boolean {
    if (settings.store.hasAcceptedToUsePlugin === true) {
        return true;
    }

    const accepted = window.confirm(CONSENT_WARNING);
    settings.store.hasAcceptedToUsePlugin = accepted;

    if (!accepted) {
        console.warn("Consent not accepted. Quest completion is disabled.");
    }

    return accepted;
}

function updateQuests() {
    try {
        if (!settings.store.hasAcceptedToUsePlugin) {
            stopAllFarming();
            return;
        }

        scrubCachedSuperProperties();
        if (!QuestsStore?.quests) return;

        availableQuests = [...QuestsStore.quests.values()];
        acceptableQuests = availableQuests.filter(x => x?.config?.expiresAt && x.userStatus?.enrolledAt == null && new Date(x.config.expiresAt).getTime() > Date.now()) || [];
        completableQuests = availableQuests.filter(x => x?.config?.expiresAt && x.userStatus?.enrolledAt && !x.userStatus?.completedAt && new Date(x.config.expiresAt).getTime() > Date.now()) || [];
        claimableQuests = availableQuests.filter(x => x?.config?.expiresAt && x.userStatus?.completedAt && !x.userStatus?.claimedAt && new Date(x.config.expiresAt).getTime() > Date.now()) || [];
        for (const quest of acceptableQuests) {
            if (isQuestEligibleForFarming(quest)) {
                acceptQuest(quest);
            }
        }
        if (settings.store.claimRewardsAutomatically && claimableQuests.length > 0) {
            processClaimQueue();
        }
        for (const quest of completableQuests) {
            if (!quest?.id) continue;
            if (completingQuest.has(quest.id)) {
                if (completingQuest.get(quest.id) === false) {
                    completingQuest.delete(quest.id);
                }
            }
        }

        const activeValues = [...completingQuest.values()];
        let hasActiveVideo = activeValues.includes("video");
        let hasActiveGame = activeValues.includes("game");
        let hasActiveActivity = activeValues.includes("activity");

        for (const quest of completableQuests) {
            if (!quest?.id || completingQuest.has(quest.id)) continue;
            if (!isQuestEligibleForFarming(quest)) continue;
            const tc = quest.config?.taskConfig ?? quest.config?.taskConfigV2;
            if (!tc?.tasks) continue;
            const tName = SUPPORTED_TASK_NAMES.find(x => (tc.tasks as any)[x] != null);
            if (!tName) continue;
            const isVideo = tName === "WATCH_VIDEO" || tName === "WATCH_VIDEO_ON_MOBILE";
            const isAchievement = tName === "ACHIEVEMENT_IN_ACTIVITY" || tName === "ACHIEVEMENT_IN_GAME";
            if (isVideo) {
                if (hasActiveVideo) continue;
                hasActiveVideo = true;
                completeQuest(quest);
            } else if (isAchievement) {
                if (hasActiveActivity || attemptedAchievementQuestIds.has(quest.id)) continue;
                hasActiveActivity = true;
                completeQuest(quest);
            } else {
                if (hasActiveGame) continue;
                hasActiveGame = true;
                completeQuest(quest);
            }
        }
    } catch (err) {
        console.error("[CompleteDiscordQuest] Error in updateQuests:", err);
    }
}

async function acceptQuest(quest: QuestValue) {
    if (!settings.store.acceptQuestsAutomatically || !quest?.id || enrollingQuestIds.has(quest.id)) return;
    try {
        enrollingQuestIds.add(quest.id);
        const questName = quest?.config?.messages?.questName ?? quest.id;
        const tc = quest?.config?.taskConfig ?? quest?.config?.taskConfigV2;
        const tasks = (tc?.tasks ?? {}) as Record<string, any>;
        const isActivityQuest = Boolean(tasks.PLAY_ACTIVITY || tasks.ACHIEVEMENT_IN_ACTIVITY || tasks.ACHIEVEMENT_IN_GAME);
        console.log("Accepting quest:", questName);

        await ensureSealedQuestMetadata(quest.id);

        const action: QuestAction = {
            questContent: QuestLocationMap?.QUEST_HOME_DESKTOP ?? 11,
            questContentCTA: isActivityQuest ? "START_QUEST" : "ACCEPT_QUEST",
            sourceQuestContent: 0,
        };
        QuestApplyAction(quest.id, action).then(() => {
            console.log("Accepted quest:", questName);
        }).catch(err => {
            console.error("Failed to accept quest:", questName, err);
        }).finally(() => {
            setTimeout(() => enrollingQuestIds.delete(quest.id), 15000);
        });
    } catch (err) {
        enrollingQuestIds.delete(quest.id);
        console.error("[CompleteDiscordQuest] Error in acceptQuest:", err);
    }
}

async function processClaimQueue() {
    if (claimLoopRunning || !settings.store.claimRewardsAutomatically) return;
    claimLoopRunning = true;
    try {
        while (settings.store.claimRewardsAutomatically && settings.store.hasAcceptedToUsePlugin) {
            const nextQuest = claimableQuests.find(q =>
                q?.id &&
                !q.userStatus?.claimedAt &&
                !claimingQuestIds.has(q.id) &&
                !failedClaimQuestIds.has(q.id) &&
                isQuestEligibleForFarming(q)
            );
            if (!nextQuest?.id) break;

            const questId = nextQuest.id;
            const questName = nextQuest.config?.messages?.questName ?? questId;
            const platforms = nextQuest.config?.rewardsConfig?.platforms;
            const platform = resolvePreferredRewardPlatform(platforms, settings.store.rewardPlatformPriority);
            if (platform === null) {
                failedClaimQuestIds.add(questId);
                console.log(`[CompleteDiscordQuest] Skipping auto-claim for ${questName} (rewardPlatformPriority is set to manual).`);
                continue;
            }
            const location = QuestLocationMap?.QUEST_HOME_DESKTOP ?? 11;

            claimingQuestIds.add(questId);
            let abortQueueOnCaptcha = false;
            try {
                await ensureSealedQuestMetadata(questId);
                console.log(`[CompleteDiscordQuest] Claiming completed quest reward: ${questName} (platform=${platform})`);
                if (typeof QuestClaimAction === "function") {
                    const res = await QuestClaimAction(questId, platform, location);
                    if (res?.errors?.length > 0 || res?.body?.captcha_key) {
                        failedClaimQuestIds.add(questId);
                        if (res?.body?.captcha_key || /captcha/i.test(JSON.stringify(res?.errors || ""))) {
                            abortQueueOnCaptcha = true;
                        }
                    }
                } else {
                    await RestAPI.post({
                        url: `/quests/${questId}/claim-reward`,
                        body: { platform, location }
                    });
                }
            } catch (claimErr: any) {
                // Do not retry quests that require interactive Captcha or return 4xx
                failedClaimQuestIds.add(questId);
                console.warn("[CompleteDiscordQuest] Auto-claim skipped/deferred to manual UI for:", questName, claimErr);
                if (claimErr?.status === 400 || claimErr?.status === 403 || claimErr?.body?.captcha_key || /captcha/i.test(String(claimErr?.message || claimErr))) {
                    abortQueueOnCaptcha = true;
                }
            } finally {
                claimingQuestIds.delete(questId);
            }
            if (abortQueueOnCaptcha) {
                break;
            }

            // Human-like 5..8s spacing between reward claims
            const delayMs = 5000 + Math.floor(Math.random() * 3000);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    } finally {
        claimLoopRunning = false;
    }
}

function stopCompletingAll() {
    for (const questId of completingQuest.keys()) {
        completingQuest.set(questId, false);
    }
    console.log("Stopped completing all quests.");
}

function stopAllFarming() {
    stopCompletingAll();

    for (const listener of activeHeartbeatListeners) {
        FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", listener);
    }
    activeHeartbeatListeners.clear();

    if (fakeGames.size > 0) {
        const removedGames = Array.from(fakeGames.values());
        const expiresAt = Date.now() + 15000;
        for (const rg of removedGames) {
            if (rg?.pid != null) {
                recentFakeGamesByPid.set(Number(rg.pid), { game: rg, expiresAt });
            }
        }
        fakeGames.clear();
        const games = RunningGameStore?.getRunningGames?.() ?? [];
        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: removedGames, added: [], games });
    }

    if (fakeApplications.size > 0) {
        fakeApplications.clear();
    }
}

function completeQuest(quest: QuestValue) {
    if (!settings.store.hasAcceptedToUsePlugin) {
        stopAllFarming();
        console.warn("Consent not accepted. Cannot complete quests.");
        return;
    }

    if (!quest?.id) {
        return;
    }

    try {
        const isApp = typeof DiscordNative !== "undefined";
        // Windows PIDs are always multiples of 4; use a separate small observer ID (1..32)
        const pid = (Math.floor(Math.random() * 7500) + 1000) * 4;
        const observerId = ((nextObserverId++ - 1) % 32) + 1;

        const questName = quest.config?.messages?.questName ?? quest.id;
        const taskConfig = quest.config?.taskConfig ?? quest.config?.taskConfigV2;
        if (!taskConfig?.tasks) {
            console.log("No taskConfig.tasks for quest:", questName);
            completingQuest.set(quest.id, false);
            return;
        }
        const taskName = SUPPORTED_TASK_NAMES.find(x => (taskConfig.tasks as any)[x] != null);
        if (!taskName) {
            console.log("Unknown task type for quest:", questName);
            completingQuest.set(quest.id, false);
            return;
        }
        const taskData = (taskConfig.tasks as any)[taskName] as any;
        const applicationId = taskData?.applications?.[0]?.id ?? quest.config?.application?.id;
        const applicationName = quest.config?.application?.name ?? quest.config?.messages?.gameTitle ?? questName;
        const secondsNeeded = taskData?.target ?? 1;
        let secondsDone = (quest.userStatus?.progress as any)?.[taskName]?.value ?? 0;

        if (!isApp && taskName !== "WATCH_VIDEO" && taskName !== "WATCH_VIDEO_ON_MOBILE") {
            console.log("This no longer works in browser for non-video quests (" + taskName + "). Use the discord desktop app to complete the", questName, "quest!");
            completingQuest.set(quest.id, false);
            return;
        }

        const isVideoTask = taskName === "WATCH_VIDEO" || taskName === "WATCH_VIDEO_ON_MOBILE";
        const isAchievementTask = taskName === "ACHIEVEMENT_IN_ACTIVITY" || taskName === "ACHIEVEMENT_IN_GAME";
        completingQuest.set(quest.id, isVideoTask ? "video" : (isAchievementTask ? "activity" : "game"));

        console.log(`Completing quest ${questName} (${quest.id}) - ${taskName} for ${secondsNeeded} target.`);

        switch (taskName) {
            case "WATCH_VIDEO":
            case "WATCH_VIDEO_ON_MOBILE": {
                // Real-time 1x pacing (10s advance per ~10s interval) anchored to session start
                const maxFuture = 8, speed = 10, interval = 10;
                const enrolledAt = quest.userStatus?.enrolledAt ? new Date(quest.userStatus.enrolledAt).getTime() : Date.now();
                const sessionStartMs = Date.now();
                const initialProgress = secondsDone;
                let completed = false;
                const watchVideo = async () => {
                    try {
                        while (true) {
                            const anchorMs = Math.max(enrolledAt, sessionStartMs - maxFuture * 1000);
                            const maxAllowed = initialProgress + Math.floor((Date.now() - anchorMs) / 1000) + maxFuture;
                            const diff = maxAllowed - secondsDone;
                            const nextStep = secondsDone + speed;

                            if (!completingQuest.get(quest.id)) {
                                console.log("Stopping completing quest:", questName);
                                completingQuest.set(quest.id, false);
                                break;
                            }

                            if (diff >= speed || nextStep >= secondsNeeded) {
                                const isFinalStep = nextStep >= secondsNeeded;
                                const jitter = isFinalStep ? 0 : Number((0.12 + Math.random() * 0.76).toFixed(3));
                                const sendTs = isFinalStep ? secondsNeeded : Math.min(secondsNeeded, Number((nextStep + jitter).toFixed(3)));
                                const bodyPayload = { timestamp: sendTs };
                                try {
                                    const res = await RestAPI.post({ url: `/quests/${quest.id}/video-progress`, body: bodyPayload });
                                    completed = res?.body?.completed_at != null;
                                    const effectiveTs = typeof bodyPayload.timestamp === "number" ? bodyPayload.timestamp : sendTs;
                                    secondsDone = Math.min(secondsNeeded, Math.floor(effectiveTs));
                                } catch (postErr: any) {
                                    if (postErr?.status === 429) {
                                        const retryMs = ((postErr?.body?.retry_after as number) || 5) * 1000 + 500;
                                        await new Promise(resolve => setTimeout(resolve, retryMs));
                                        continue;
                                    }
                                    throw postErr;
                                }
                            }

                            if (completed || secondsDone >= secondsNeeded) {
                                break;
                            }
                            const jitterMs = Math.floor(Math.random() * 1500);
                            await new Promise(resolve => setTimeout(resolve, interval * 1000 + jitterMs));
                        }
                        if (!completed && completingQuest.get(quest.id)) {
                            try {
                                const res = await RestAPI.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: secondsNeeded } });
                                completed = res?.body?.completed_at != null;
                            } catch (finalErr: any) {
                                if (finalErr?.status === 429) {
                                    const retryMs = ((finalErr?.body?.retry_after as number) || 5) * 1000 + 500;
                                    await new Promise(resolve => setTimeout(resolve, retryMs));
                                    if (completingQuest.get(quest.id)) {
                                        const res = await RestAPI.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: secondsNeeded } });
                                        completed = res?.body?.completed_at != null;
                                    }
                                }
                            }
                        }
                        console.log("Quest completed:", questName);
                        // Transition from "video" to `true` so the next video quest in the queue can start,
                        // while preventing this quest from being re-triggered before QuestsStore updates.
                        completingQuest.set(quest.id, true);
                        setTimeout(() => {
                            if (!quest.userStatus?.completedAt) {
                                completingQuest.set(quest.id, false);
                            }
                            updateQuests();
                        }, completed ? 5000 : 30000);
                        setTimeout(updateQuests, 2000);
                    } catch (err) {
                        console.error("Error in watchVideo for quest:", questName, err);
                        completingQuest.set(quest.id, true);
                        setTimeout(() => {
                            completingQuest.set(quest.id, false);
                            updateQuests();
                        }, 30000);
                    }
                };
                watchVideo();
                console.log(`Spoofing video for ${questName} (1x real-time stealth pacing).`);
                break;
            }

            case "PLAY_ON_DESKTOP": {
                if (!applicationId) {
                    console.warn("No applicationId found for PLAY_ON_DESKTOP quest:", questName);
                    completingQuest.set(quest.id, false);
                    break;
                }
                RestAPI.get({ url: `/applications/public?application_ids=${applicationId}` })
                    .catch(() => ({ body: [] }))
                    .then(async res => {
                        const appData = res?.body?.[0] ?? { id: applicationId, name: applicationName, executables: [] };
                        const safeAppName = appData.name || applicationName || "Game";
                        const rawExe = appData.executables?.find((x: any) => x.os === "win32")?.name?.replace(/^>+/, "") ?? `${safeAppName.replace(/[/\\:*?"<>|]/g, "")}.exe`;
                        const cleanAppFolder = safeAppName.replace(/[/\\:*?"<>|]/g, "").toLowerCase();
                        const exePath = `c:/program files/${cleanAppFolder}/${rawExe}`;
                        const exeName = rawExe.split(/[/\\]/).pop() || rawExe;
                        const currentRealGames = RunningGameStore?.getRunningGames?.() ?? [];
                        const currentUserId = UserStore?.getCurrentUser?.()?.id ?? "";
                        const executableFingerprint = await synthesizeSignedExecutableFingerprint(currentUserId, applicationId, exePath, currentRealGames, safeAppName);
                        if (!completingQuest.get(quest.id)) {
                            return;
                        }

                        const fakeGame = {
                            cmdLine: `"C:\\Program Files\\${safeAppName}\\${rawExe.replace(/\//g, "\\")}"`,
                            distributor: null,
                            elevated: false,
                            exeName,
                            exePath,
                            executableFingerprint,
                            fullscreenType: 0,
                            gameMetadata: undefined,
                            hidden: false,
                            id: applicationId,
                            isLauncher: false,
                            lastFocused: Math.floor(Date.now() / 1000),
                            name: safeAppName,
                            nativeProcessObserverId: observerId,
                            origGameName: safeAppName,
                            pid: pid,
                            pidPath: [pid],
                            processName: exeName.replace(/\.exe$/i, ""),
                            sandboxed: false,
                            sku: null,
                            start: Date.now() - Math.floor(Math.random() * 8000 + 2000),
                            windowHandle: null,
                        };
                        fakeGames.set(quest.id, fakeGame);
                        const mergedGames = RunningGameStore?.getRunningGames?.() ?? [fakeGame];
                        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [], added: [fakeGame], games: mergedGames });

                        const playOnDesktop = (event: any) => {
                            try {
                                if (event?.questId !== quest.id) return;
                                const progress = quest.config?.configVersion === 1
                                    ? (event?.userStatus?.streamProgressSeconds ?? 0)
                                    : Math.floor(event?.userStatus?.progress?.PLAY_ON_DESKTOP?.value ?? 0);
                                console.log(`Quest progress ${questName}: ${progress}/${secondsNeeded}`);

                                if (!completingQuest.get(quest.id) || progress >= secondsNeeded) {
                                    console.log("Stopping completing quest:", questName);

                                    recentFakeGamesByPid.set(Number(fakeGame.pid), { game: fakeGame, expiresAt: Date.now() + 15000 });
                                    fakeGames.delete(quest.id);
                                    const games = RunningGameStore?.getRunningGames?.() ?? [];
                                    FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games });
                                    FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", playOnDesktop);
                                    activeHeartbeatListeners.delete(playOnDesktop);

                                    if (progress >= secondsNeeded) {
                                        console.log("Quest completed!");
                                        completingQuest.set(quest.id, true);
                                        setTimeout(() => {
                                            if (!quest.userStatus?.completedAt) {
                                                completingQuest.set(quest.id, false);
                                            }
                                            updateQuests();
                                        }, 10000);
                                        setTimeout(updateQuests, 2000);
                                    } else {
                                        completingQuest.set(quest.id, false);
                                    }
                                }
                            } catch (err) {
                                console.error("Error in playOnDesktop listener:", err);
                            }
                        };
                        activeHeartbeatListeners.add(playOnDesktop);
                        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", playOnDesktop);

                        console.log(`Spoofed your game to ${safeAppName} (path: ${formatQuestExecutablePath(exePath)}, 196-char signed executableFingerprint attached). Wait for ${Math.ceil((secondsNeeded - secondsDone) / 60)} more minutes.`);
                    }).catch(err => {
                    console.error("Failed to fetch application info for PLAY_ON_DESKTOP quest:", questName, err);
                    completingQuest.set(quest.id, false);
                });
                break;
            }

            case "STREAM_ON_DESKTOP": {
                if (!applicationId) {
                    console.warn("No applicationId found for STREAM_ON_DESKTOP quest:", questName);
                    completingQuest.set(quest.id, false);
                    break;
                }
                const fakeApp = {
                    id: applicationId,
                    name: applicationName,
                    pid: pid,
                    sourceName: null,
                };
                fakeApplications.set(quest.id, fakeApp);

                const streamOnDesktop = (event: any) => {
                    try {
                        if (event?.questId !== quest.id) return;
                        const progress = quest.config?.configVersion === 1
                            ? (event?.userStatus?.streamProgressSeconds ?? 0)
                            : Math.floor(event?.userStatus?.progress?.STREAM_ON_DESKTOP?.value ?? 0);
                        console.log(`Quest progress ${questName}: ${progress}/${secondsNeeded}`);

                        if (!completingQuest.get(quest.id) || progress >= secondsNeeded) {
                            console.log("Stopping completing quest:", questName);

                            fakeApplications.delete(quest.id);
                            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", streamOnDesktop);
                            activeHeartbeatListeners.delete(streamOnDesktop);

                            if (progress >= secondsNeeded) {
                                console.log("Quest completed!");
                                completingQuest.set(quest.id, true);
                                setTimeout(() => {
                                    if (!quest.userStatus?.completedAt) {
                                        completingQuest.set(quest.id, false);
                                    }
                                    updateQuests();
                                }, 10000);
                                setTimeout(updateQuests, 2000);
                            } else {
                                completingQuest.set(quest.id, false);
                            }
                        }
                    } catch (err) {
                        console.error("Error in streamOnDesktop listener:", err);
                    }
                };
                activeHeartbeatListeners.add(streamOnDesktop);
                FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", streamOnDesktop);

                console.log(`Spoofed your stream to ${applicationName}. Stream any window in vc for ${Math.ceil((secondsNeeded - secondsDone) / 60)} more minutes.`);
                console.log("Remember that you need at least 1 other person to be in the vc!");
                break;
            }

            case "PLAY_ACTIVITY":
            case "ACHIEVEMENT_IN_ACTIVITY":
            case "ACHIEVEMENT_IN_GAME": {
                const channelId = ChannelStore?.getSortedPrivateChannels?.()?.[0]?.id
                    ?? (Object.values(GuildChannelStore?.getAllGuilds?.() ?? {}) as any[]).find(x => x != null && Array.isArray(x.VOCAL) && x.VOCAL.length > 0)?.VOCAL?.[0]?.channel?.id
                    ?? "1";
                const streamKey = `call:${channelId}:1`;

                const runActivityQuest = async () => {
                    const restoreSiblings = isAchievementTask
                        ? deprioritizeCompletedSiblingQuests(quest.id, applicationId)
                        : () => {};
                    let autoLaunchedFrameId: string | null = null;
                    try {
                        console.log(`Completing activity quest ${questName} (${taskName}, app=${applicationId ?? "none"})`);
                        try {
                            FluxDispatcher.dispatch({ type: "QUEST_APPLICATION_START_TIMER", questId: quest.id });
                        } catch {}

                        if (isAchievementTask && applicationId) {
                            try {
                                await RestAPI.post({
                                    url: `/applications/${applicationId}/proxy-ticket`,
                                    body: {}
                                }).catch(() => null);
                            } catch {}

                            // Layer 1: If an Activity iframe is already mounted in the DOM, broadcast completion immediately
                            const initialFrames = broadcastQuestCompletedToActivityFrames(applicationId);
                            if (initialFrames > 0) {
                                console.log(`[CompleteDiscordQuest] Broadcasted quest-completed to ${initialFrames} active frame(s) for ${questName}.`);
                            }

                            // Layer 2: Headless OAuth2 code exchange + Activity backend API completion (/.proxy/acf/authorize -> /.proxy/acf/quest/progress)
                            const headlessOk = await tryCompleteAchievementActivityHeadless(quest.id, String(applicationId), secondsNeeded);
                            if (headlessOk) {
                                await new Promise(resolve => setTimeout(resolve, 1500));
                                const verified = await refreshQuestCompletionState(quest.id, taskName, secondsNeeded);
                                if (verified || headlessOk) {
                                    console.log(`[CompleteDiscordQuest] Completed interactive activity quest headlessly: ${questName}`);
                                    completingQuest.set(quest.id, true);
                                    setTimeout(() => {
                                        if (!quest.userStatus?.completedAt) {
                                            completingQuest.set(quest.id, false);
                                        }
                                        updateQuests();
                                    }, 8000);
                                    setTimeout(updateQuests, 1500);
                                    return;
                                }
                            }

                            // Layer 3: Auto-launch Activity Frame in minimized PIP mode & drive via postMessage bridge
                            if (findActivityIframes(applicationId).length === 0 && typeof FrameManager?.launchFrame === "function") {
                                try {
                                    console.log(`[CompleteDiscordQuest] Auto-launching minimized PIP Activity frame for ${questName} (${applicationId})...`);
                                    const launchedId = await FrameManager.launchFrame({
                                        applicationId: String(applicationId),
                                        surface: { type: 0 },
                                        showErrorModal: false
                                    });
                                    autoLaunchedFrameId = typeof launchedId === "string" ? launchedId : `main:${applicationId}`;
                                    FrameManager.updateFrameLayoutMode?.({
                                        frameId: autoLaunchedFrameId,
                                        layoutMode: 1 // PIP minimized
                                    });
                                } catch (launchErr) {
                                    console.warn(`[CompleteDiscordQuest] Auto-launch frame fallback notice for ${questName}:`, launchErr);
                                }
                            }

                            for (let cycle = 0; cycle < 12; cycle++) {
                                if (!completingQuest.get(quest.id)) break;
                                await new Promise(resolve => setTimeout(resolve, 6500));
                                if (!completingQuest.get(quest.id)) break;

                                broadcastQuestCompletedToActivityFrames(applicationId);
                                if (cycle === 2 || cycle === 6) {
                                    await tryCompleteAchievementActivityHeadless(quest.id, String(applicationId), secondsNeeded).catch(() => false);
                                }

                                const doneNow = await refreshQuestCompletionState(quest.id, taskName, secondsNeeded);
                                if (doneNow) {
                                    console.log(`Quest completed: ${questName}`);
                                    completingQuest.set(quest.id, true);
                                    setTimeout(() => {
                                        if (!quest.userStatus?.completedAt) {
                                            completingQuest.set(quest.id, false);
                                        }
                                        updateQuests();
                                    }, 8000);
                                    setTimeout(updateQuests, 1500);
                                    return;
                                }
                            }
                        }

                        let stagnantCycles = 0;
                        let lastProgress = secondsDone;

                        while (true) {
                            if (!completingQuest.get(quest.id)) {
                                completingQuest.set(quest.id, false);
                                break;
                            }

                            if (isAchievementTask && applicationId) {
                                broadcastQuestCompletedToActivityFrames(applicationId);
                            }

                            const body: Record<string, any> = {
                                stream_key: streamKey,
                                terminal: false
                            };
                            if (applicationId) {
                                body.application_id = applicationId;
                            }

                            let res: any;
                            try {
                                res = await RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body });
                                if (res?.body) {
                                    FluxDispatcher.dispatch({
                                        type: "QUESTS_SEND_HEARTBEAT_SUCCESS",
                                        userStatus: res.body,
                                        questId: quest.id,
                                        streamKey
                                    });
                                }
                            } catch (hbErr: any) {
                                if (hbErr?.status === 429) {
                                    const retryMs = ((hbErr?.body?.retry_after as number) || 10) * 1000 + 500;
                                    await new Promise(resolve => setTimeout(resolve, retryMs));
                                    continue;
                                }
                                if (isAchievementTask && hbErr?.status >= 400 && hbErr?.status < 500) {
                                    attemptedAchievementQuestIds.add(quest.id);
                                    completingQuest.set(quest.id, true);
                                    console.log(`[CompleteDiscordQuest] ${questName} (${taskName}) enrolled; awaiting server-side activity achievement event.`);
                                    setTimeout(updateQuests, 2000);
                                    break;
                                }
                                throw hbErr;
                            }

                            const progress = res?.body?.progress?.[taskName]?.value
                                ?? res?.body?.progress?.PLAY_ACTIVITY?.value
                                ?? res?.body?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value
                                ?? res?.body?.progress?.ACHIEVEMENT_IN_GAME?.value
                                ?? 0;
                            const isCompleted = res?.body?.completed_at != null || progress >= secondsNeeded;
                            console.log(`Quest progress ${questName} (${taskName}): ${progress}/${secondsNeeded}`);

                            if (!completingQuest.get(quest.id) || isCompleted) {
                                console.log("Stopping completing quest:", questName);

                                if (isCompleted) {
                                    const termBody: Record<string, any> = {
                                        stream_key: streamKey,
                                        terminal: true
                                    };
                                    if (applicationId) {
                                        termBody.application_id = applicationId;
                                    }
                                    try {
                                        await RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body: termBody });
                                    } catch (termErr: any) {
                                        if (termErr?.status === 429) {
                                            const retryMs = ((termErr?.body?.retry_after as number) || 10) * 1000 + 500;
                                            await new Promise(resolve => setTimeout(resolve, retryMs));
                                            if (completingQuest.get(quest.id)) {
                                                await RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body: termBody });
                                            }
                                        }
                                    }
                                    console.log("Quest completed:", questName);
                                    completingQuest.set(quest.id, true);
                                    setTimeout(() => {
                                        if (!quest.userStatus?.completedAt) {
                                            completingQuest.set(quest.id, false);
                                        }
                                        updateQuests();
                                    }, 10000);
                                    setTimeout(updateQuests, 2000);
                                } else {
                                    completingQuest.set(quest.id, false);
                                }
                                break;
                            }

                            if (isAchievementTask) {
                                if (progress <= lastProgress) {
                                    stagnantCycles++;
                                } else {
                                    stagnantCycles = 0;
                                    lastProgress = progress;
                                }
                                if (stagnantCycles >= 2) {
                                    attemptedAchievementQuestIds.add(quest.id);
                                    completingQuest.set(quest.id, true);
                                    console.log(`[CompleteDiscordQuest] ${questName} (${taskName}) enrolled & heartbeat initialized; awaiting server-side activity achievement event.`);
                                    setTimeout(updateQuests, 2000);
                                    break;
                                }
                            }

                            await new Promise(resolve => setTimeout(resolve, (60 * 1000) + Math.floor(Math.random() * 1500)));
                        }
                    } catch (err) {
                        console.error("Error in runActivityQuest for quest:", questName, err);
                        if (isAchievementTask) {
                            attemptedAchievementQuestIds.add(quest.id);
                        }
                        completingQuest.set(quest.id, false);
                    } finally {
                        if (autoLaunchedFrameId && applicationId) {
                            try {
                                FluxDispatcher.dispatch({
                                    type: "FRAME_STOP",
                                    applicationId: String(applicationId),
                                    frameId: autoLaunchedFrameId
                                });
                            } catch {}
                        }
                        restoreSiblings();
                    }
                };
                runActivityQuest();
                break;
            }

            default:
                console.error("Unknown task type:", taskName);
                completingQuest.set(quest.id, false);
                break;
        }
    } catch (err) {
        console.error("[CompleteDiscordQuest] Error in completeQuest:", err);
        completingQuest.set(quest.id, false);
    }
}

function deprioritizeCompletedSiblingQuests(activeQuestId: string, applicationId?: string | null): () => void {
    const originalEnrolledAt = new Map<any, string>();
    try {
        const questsMap = QuestsStore?.quests;
        if (!questsMap || typeof questsMap.values !== "function") return () => {};
        for (const q of questsMap.values()) {
            if (!q || q.id === activeQuestId) continue;
            if (q.userStatus?.completedAt != null && typeof q.userStatus?.enrolledAt === "string") {
                const tc = q.config?.taskConfig ?? q.config?.taskConfigV2;
                const tasksObj = tc?.tasks ? Object.values(tc.tasks) : [];
                const matchesApp =
                    !applicationId ||
                    String(q.config?.application?.id) === String(applicationId) ||
                    tasksObj.some((t: any) => Array.isArray(t?.applications) && t.applications.some((a: any) => String(a?.id) === String(applicationId)));
                if (matchesApp) {
                    originalEnrolledAt.set(q.userStatus, q.userStatus.enrolledAt);
                    q.userStatus.enrolledAt = "2099-01-01T00:00:00.000Z";
                }
            }
        }
    } catch {}
    return () => {
        for (const [statusObj, origVal] of originalEnrolledAt.entries()) {
            try {
                statusObj.enrolledAt = origVal;
            } catch {}
        }
        originalEnrolledAt.clear();
    };
}

function findActivityIframes(applicationId?: string | null): HTMLIFrameElement[] {
    try {
        const allIframes = Array.from(document.querySelectorAll("iframe"));
        return allIframes.filter(iframe => {
            const src = String(iframe?.src || "");
            if (!src.includes("discordsays.com")) return false;
            return !applicationId || src.includes(String(applicationId));
        });
    } catch {
        return [];
    }
}

function broadcastQuestCompletedToActivityFrames(applicationId?: string | null): number {
    const frames = findActivityIframes(applicationId);
    let sent = 0;
    for (const iframe of frames) {
        try {
            if (iframe?.contentWindow) {
                iframe.contentWindow.postMessage({ type: "award-title", payload: "f0rsaken-ace" }, "*");
                iframe.contentWindow.postMessage({ type: "quest-completed" }, "*");
                sent++;
            }
        } catch {}
    }
    return sent;
}

async function obtainActivityOAuthCode(applicationId: string): Promise<string | null> {
    const bodies = [
        {
            permissions: "0",
            authorize: true,
            integration_type: 1,
            location_context: { guild_id: "10000", channel_id: "10000", channel_type: 10000 }
        },
        {
            permissions: "0",
            authorize: true,
            integration_type: 0,
            location_context: { guild_id: "10000", channel_id: "10000", channel_type: 10000 }
        },
        {
            permissions: "0",
            authorize: true
        }
    ];
    for (const body of bodies) {
        try {
            const res = await RestAPI.post({
                url: "/oauth2/authorize",
                query: {
                    client_id: String(applicationId),
                    response_type: "code",
                    scope: "identify",
                    prompt: "none",
                    state: ""
                },
                body
            });
            const loc: string | undefined = res?.body?.location;
            if (typeof loc === "string" && loc.includes("code=")) {
                try {
                    const parsed = new URL(loc);
                    const code = parsed.searchParams.get("code");
                    if (code) return code;
                } catch {
                    const m = loc.match(/[?&]code=([^&#]+)/);
                    if (m?.[1]) return decodeURIComponent(m[1]);
                }
            }
        } catch (err: any) {
            if (err?.status === 429) {
                const retryMs = ((err?.body?.retry_after as number) || 5) * 1000 + 500;
                await new Promise(resolve => setTimeout(resolve, retryMs));
            }
        }
    }
    return null;
}

async function tryCompleteAchievementActivityHeadless(
    questId: string,
    applicationId: string,
    target = 1
): Promise<boolean> {
    try {
        const nativeHelper =
            (VencordNative as any)?.pluginHelpers?.CompleteDiscordQuest ??
            (VencordNative as any)?.pluginHelpers?.DiscordStealthGuard;

        if (typeof nativeHelper?.completeActivityQuest === "function") {
            const code = await obtainActivityOAuthCode(applicationId);
            if (code) {
                const nativeRes = await nativeHelper.completeActivityQuest(
                    String(applicationId),
                    String(questId),
                    code,
                    target
                ).catch(() => null);
                if (nativeRes?.ok) {
                    return true;
                }
            }
        }

        const rendererCode = await obtainActivityOAuthCode(applicationId);
        if (!rendererCode) return false;

        const baseOrigin = `https://${applicationId}.discordsays.com`;
        const buildHeaders = (token = "") => ({
            "Content-Type": "application/json",
            "Accept": "*/*",
            "X-Auth-Token": token,
            "X-Universe-ID": "78a74ba6-b027-4b0e-a686-9a6f4124c068",
            "X-Discord-Activity-Id": String(applicationId),
            "X-Discord-Hostname": `${applicationId}.discordsays.com`,
            "X-Arise-Client": "spades-prod-main-4835c58"
        });

        const authRes = await fetch(`${baseOrigin}/.proxy/acf/authorize`, {
            method: "POST",
            headers: buildHeaders(""),
            body: JSON.stringify({ code: rendererCode, activityId: String(applicationId) })
        });
        if (!authRes.ok) return false;
        const authData: any = await authRes.json().catch(() => null);
        const acfToken: string = authData?.token || authData?.authToken || "";
        if (!acfToken) return false;

        let ariseToken = acfToken;
        try {
            const regRes = await fetch(`${baseOrigin}/.proxy/acf/arise/register`, {
                method: "POST",
                headers: buildHeaders(acfToken)
            });
            if (regRes.ok) {
                const regData: any = await regRes.json().catch(() => null);
                if (regData?.authToken) ariseToken = regData.authToken;
            }
        } catch {}

        await fetch(`${baseOrigin}/.proxy/api/profileTitle/add`, {
            method: "POST",
            headers: buildHeaders(ariseToken),
            body: JSON.stringify({ id: "f0rsaken-ace" })
        }).catch(() => null);

        await fetch(`${baseOrigin}/.proxy/api/profile/mission-completed`, {
            method: "POST",
            headers: buildHeaders(ariseToken)
        }).catch(() => null);

        const progRes = await fetch(`${baseOrigin}/.proxy/acf/quest/progress`, {
            method: "POST",
            headers: buildHeaders(acfToken),
            body: JSON.stringify({ progress: Math.max(1, Number(target) || 1), quest_id: String(questId) })
        });
        if (!progRes.ok) return false;
        const progData: any = await progRes.json().catch(() => null);
        return progData?.status === "ok" || progData?.success !== false;
    } catch {
        return false;
    }
}

async function refreshQuestCompletionState(questId: string, taskName: string, target: number): Promise<boolean> {
    try {
        const checkStore = () => {
            const q = QuestsStore?.getQuest?.(questId) ?? QuestsStore?.quests?.get?.(questId);
            if (!q) return false;
            const val = (q.userStatus?.progress as any)?.[taskName]?.value
                ?? (q.userStatus?.progress as any)?.ACHIEVEMENT_IN_ACTIVITY?.value
                ?? (q.userStatus?.progress as any)?.ACHIEVEMENT_IN_GAME?.value
                ?? 0;
            return q.userStatus?.completedAt != null || val >= target;
        };
        if (checkStore()) return true;

        const fetchCurrentQuests = find(filters.byCode("QUESTS_FETCH_CURRENT_QUESTS_BEGIN"), { isIndirect: true });
        if (typeof fetchCurrentQuests === "function") {
            await Promise.resolve(fetchCurrentQuests()).catch(() => null);
        }
        return checkStore();
    } catch {
        return false;
    }
}

