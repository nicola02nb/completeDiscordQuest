/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import { FluxDispatcher, RestAPI } from "@webpack/common";

import { QuestButton, QuestsCount } from "./components/QuestButton";
import settings from "./settings";
import { ApplicationStreamingStore, ChannelStore, GuildChannelStore, QuestsStore, RunningGameStore, SuperPropertiesStore, UserStore } from "./stores";

const QuestApplyAction = findByCodeLazy("type:\"QUESTS_ENROLL_BEGIN\"") as (questId: string, action: QuestAction) => Promise<any>;
const QuestClaimAction = findByCodeLazy("type:\"QUESTS_CLAIM_REWARD_BEGIN\"") as (questId: string, platform: number, location: number) => Promise<any>;
const QuestLocationMap = findByPropsLazy("QUEST_HOME_DESKTOP", "11") as Record<string, any>;

let availableQuests: QuestValue[] = [];
let acceptableQuests: QuestValue[] = [];
let completableQuests: QuestValue[] = [];
let claimableQuests: QuestValue[] = [];

const completingQuest = new Map<string, boolean | "video" | "game">();
const enrollingQuestIds = new Set<string>();
const claimingQuestIds = new Set<string>();
const failedClaimQuestIds = new Set<string>();
let claimLoopRunning = false;
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

function cloakFunction<T extends Function>(fn: T, originalFn?: Function | null, fallbackName = ""): T {
    ensureToStringCloak();
    try {
        const name = originalFn?.name || fallbackName;
        let nativeSource = originalFn
            ? (hookedFunctions.get(originalFn) ?? Function.prototype.toString.call(originalFn))
            : `function ${name}() { [native code] }`;
        if (/Vencord|Vesktop|Equicord|BetterDiscord/i.test(nativeSource)) {
            nativeSource = `function ${name}() { [native code] }`;
        }
        hookedFunctions.set(fn, nativeSource);
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

const PUBLISHER_COMMON_NAMES: Array<{ match: RegExp; publisher: string; }> = [
    { match: /counter-strike|cs2|dota|deadlock|team fortress|half-life|left 4 dead|portal|steam/i, publisher: "Valve Corp." },
    { match: /path of exile|pathofexile|grinding gear/i, publisher: "Grinding Gear Games Limited" },
    { match: /age of empires|reliccardinal|essenceeditor/i, publisher: "Relic Entertainment Inc." },
    { match: /valorant|league of legends|riot|legends of runeterra|2xko/i, publisher: "Riot Games, Inc." },
    { match: /fortnite|rocket league|fall guys|alan wake|epic games|unreal/i, publisher: "Epic Games Inc." },
    { match: /overwatch|diablo|warcraft|hearthstone|starcraft|call of duty|battle\.net|blizzard/i, publisher: "Blizzard Entertainment, Inc." },
    { match: /genshin|honkai|zenless|hoyoverse|mihoyo|cognosphere/i, publisher: "COGNOSPHERE PTE. LTD." },
    { match: /apex legends|battlefield|ea sports|the sims|electronic arts|Respawn/i, publisher: "Electronic Arts, Inc." },
    { match: /rainbow six|assassin's creed|far cry|the division|xdefiant|skull and bones|ubisoft/i, publisher: "Ubisoft Entertainment Sweden AB" },
    { match: /destiny 2|marathon|bungie/i, publisher: "Bungie, Inc." },
    { match: /warframe|soulframe|digital extremes/i, publisher: "Digital Extremes Ltd." },
    { match: /pubg|krafton/i, publisher: "KRAFTON, Inc." },
    { match: /marvel rivals|once human|naraka|netease/i, publisher: "NetEase Interactive Entertainment Pte. Ltd" },
    { match: /delta force|arena breakout|honor of kings|nikke|proxima beta|level infinite|tencent/i, publisher: "Proxima Beta Pte. Limited" },
    { match: /the finals|arc raiders|embark/i, publisher: "Embark Studios AB" },
    { match: /helldivers|arrowhead|playstation|sony/i, publisher: "PlayStation PC LLC" },
    { match: /halo|forza|minecraft|sea of thieves|flight simulator|xbox|microsoft/i, publisher: "Microsoft Corporation" },
    { match: /cyberpunk|witcher|cd projekt/i, publisher: "CD PROJEKT S.A." },
    { match: /baldur's gate|larian/i, publisher: "Larian Studios Games Ltd" },
    { match: /street fighter|monster hunter|resident evil|dragon's dogma|capcom/i, publisher: "CAPCOM CO., LTD." },
    { match: /elden ring|armored core|tekken|bandai namco/i, publisher: "Bandai Namco Entertainment Inc." },
    { match: /final fantasy|square enix/i, publisher: "SQUARE ENIX CO., LTD." },
    { match: /war thunder|enlisted|crossout|gaijin/i, publisher: "Gaijin Network Ltd" },
    { match: /world of tanks|world of warships|wargaming/i, publisher: "Wargaming.net Limited" },
    { match: /dead by daylight|behaviour/i, publisher: "Behaviour Interactive Inc." },
    { match: /escape from tarkov|battlestate/i, publisher: "Battlestate Games Limited" },
    { match: /roblox/i, publisher: "Roblox Corporation" },
    { match: /VRChat/i, publisher: "VRChat Inc." },
    { match: /rust|garry's mod|s&box|facepunch/i, publisher: "Facepunch Studios Ltd" },
    { match: /palworld|pocketpair/i, publisher: "Pocketpair, Inc." },
    { match: /wuthering waves|kuro games/i, publisher: "KURO GAMES LIMITED" },
    { match: /throne and liberty|guild wars|ncsoft/i, publisher: "NCSOFT Corporation" },
    { match: /lost ark|smilegate/i, publisher: "Smilegate RPG, Inc." },
    { match: /black desert|crimson desert|pearl abyss/i, publisher: "Pearl Abyss Corp." },
    { match: /the first descendant|maple|nexon/i, publisher: "NEXON Korea Corporation" },
];

const REAL_PUBLISHER_SPKI_SHA256: Record<string, string> = {
    "Valve Corp.": "f0688b16a4be62cd296f2e2dfba20b238c1497fa9c2aa0a8fbba0ad9a3420a18",
    "Grinding Gear Games Limited": "2d3d40abfa7983fa7a9f4b32fe12f383e9f4d987e423438986de4929795b77ff",
    "Relic Entertainment Inc.": "e27baae8be28612b16e8b594ad689c71625d3cb3e1f19a8aa8aa395111b3b361",
    "Discord Inc.": "0d0d1c0c5631ecab1e2fb4fa472e19b377a66509ad36c82114b33915a7cf426d",
};

const REAL_PE_PROFILES: Record<string, {
    flags: number;
    fileSize: number;
    timeDateStamp: number;
    sizeOfImage: number;
    peHeadersSha256: string;
    sectionsSha256: string;
    certSha256: string;
}> = {
    "win64/cs2.exe": {
        flags: 0x03,
        fileSize: 2964288,
        timeDateStamp: 0x695eb999,
        sizeOfImage: 0x2c6000,
        peHeadersSha256: "2fb0fd58b4e38c254fa74a9aa139398a0ed8496dd29b97fb95e8b76deae84fd4",
        sectionsSha256: "789919401f2d0f7bb99f8961c80c4f8f53f3c8e63580865d03771770dd640fd5",
        certSha256: "f63961a9e745efeb6b974d809c6cb221a724cf8e8e9d6c0166ab63a2a1da2da4",
    },
    "path of exile/pathofexilesteam.exe": {
        flags: 0x03,
        fileSize: 43836104,
        timeDateStamp: 0x69debee3,
        sizeOfImage: 0x2bd6000,
        peHeadersSha256: "3d8410c237deae1b8008819e49e13ba154be821258e9369f2f98f4a79ddbe251",
        sectionsSha256: "efaa5a09d9d5f95748981b68443484f3993cf21536eb242f669051215cbcb5d2",
        certSha256: "16bb0b974347dd4680ff91ef2d50f242c44d8f5d323e968f609aa606024ef095",
    },
    "arena/escapefromtarkovarena.exe": {
        flags: 0x03,
        fileSize: 3241984,
        timeDateStamp: 0x67b4340e,
        sizeOfImage: 0x329000,
        peHeadersSha256: "8d36f6659761c5c7e6281c2b105c028a0d5bc75d83c63718d2cf9e6564331d73",
        sectionsSha256: "bb069f904c9c33c84c9d3dc35bd8e2caef6f42716257113b726526fb01fa50fb",
        certSha256: "0000000000000000000000000000000000000000000000000000000000000000",
    },
};

function resolvePublisherCommonName(appName?: string | null, exePath?: string | null): string {
    const combined = `${appName ?? ""} ${exePath ?? ""}`;
    for (const entry of PUBLISHER_COMMON_NAMES) {
        if (entry.match.test(combined)) {
            return entry.publisher;
        }
    }
    if (appName && appName.trim()) {
        const clean = appName.replace(/[™®©]/g, "").trim();
        return `${clean} Studios Inc.`;
    }
    return "Epic Games Inc.";
}

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
    const publisher = resolvePublisherCommonName(appName, exePath);
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
        for (const cand of candidates) {
            const existingFp = cand?.executableFingerprint || cand?.exeFingerprint;
            if (typeof existingFp !== "string" || existingFp.length !== 196) continue;
            const raw = Uint8Array.from(atob(existingFp), c => c.charCodeAt(0));
            if (raw.length === 0x92 && raw[0] === 0x01) {
                const plain = new Uint8Array(0x92);
                plain[0] = raw[0];
                for (let i = 1; i < 0x92; i++) plain[i] = raw[i] ^ xorKey[(i - 1) & 31];
                const plainView = new DataView(plain.buffer);
                const flags = plain[1];
                const fileSizeLow = plainView.getUint32(0x02, true);
                const fileSizeHigh = plainView.getUint32(0x06, true);
                const tds = plainView.getUint32(0x0A, true);
                const imgSize = plainView.getUint32(0x0E, true);
                if ((flags & 0x01) !== 0 && (flags & 0xFC) === 0
                    && fileSizeHigh === 0 && fileSizeLow >= 4096
                    && tds >= 0x386D4380 && tds <= 0x7FFFFFFF
                    && imgSize >= 0x1000 && (imgSize & 0xFFF) === 0) {
                    harvestedHw = plain.slice(0x32, 0x52);
                    break;
                }
            }
        }
    } catch {}

    const formattedPath = formatQuestExecutablePath(exePath) ?? exePath.toLowerCase();
    const realProfile = REAL_PE_PROFILES[formattedPath];
    const hHw = await sha256("hw:" + navigator.userAgent + ":" + (navigator.hardwareConcurrency || 8) + ":" + String(userId ?? ""));

    const spkiHex = REAL_PUBLISHER_SPKI_SHA256[publisher];
    const spkiBytes = spkiHex ? hexToBytes32(spkiHex) : await sha256(`SPKI_DER_V1:${publisher}`);
    const pubBytes = enc.encode(publisher);
    const certInput = new Uint8Array(pubBytes.length + 32);
    certInput.set(pubBytes, 0);
    certInput.set(spkiBytes, pubBytes.length);
    const hCert = new Uint8Array(await crypto.subtle.digest("SHA-256", certInput));

    const buf = new Uint8Array(0x92);
    const pktView = new DataView(buf.buffer);
    buf[0x00] = 0x01; // Version = 1 (un-XORed in sub_1350)

    if (realProfile) {
        buf[0x01] = realProfile.flags | 0x01;
        pktView.setBigUint64(0x02, BigInt(realProfile.fileSize), true);
        pktView.setUint32(0x0A, realProfile.timeDateStamp >>> 0, true);
        pktView.setUint32(0x0E, realProfile.sizeOfImage >>> 0, true);
        buf.set(hexToBytes32(realProfile.peHeadersSha256), 0x12);
        buf.set(harvestedHw && harvestedHw.length === 32 ? harvestedHw : hHw, 0x32);
        buf.set(hexToBytes32(realProfile.sectionsSha256), 0x52);
        const profileCert = /^0+$/.test(realProfile.certSha256) ? hCert : hexToBytes32(realProfile.certSha256);
        buf.set(profileCert, 0x72);
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

        buf[0x01] = 0x03; // Flags = is_signed (0x01) | is_pe64 (0x02)
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
                match: /launch_signature:(\i)/g,
                replace: "launch_signature:$self.scrubLaunchSignature($1)"
            }
        }
    ],
    installRuntimeStoreHooks() {
        const self = this;
        try {
            if (RunningGameStore) {
                const rawGetGames = RunningGameStore.getRunningGames;
                if (typeof rawGetGames === "function") {
                    const boundGetGames = rawGetGames.bind(RunningGameStore);
                    RunningGameStore.getRunningGames = cloakFunction(function () {
                        return self.getRunningGames(boundGetGames());
                    }, rawGetGames, "getRunningGames");
                    storeCleanupCallbacks.push(() => {
                        RunningGameStore.getRunningGames = rawGetGames;
                    });
                }
                const rawGetPid = RunningGameStore.getGameForPID;
                if (typeof rawGetPid === "function") {
                    const boundGetPid = rawGetPid.bind(RunningGameStore);
                    RunningGameStore.getGameForPID = cloakFunction(function (pid: number) {
                        return self.getGameForPID(pid) ?? boundGetPid(pid);
                    }, rawGetPid, "getGameForPID");
                    storeCleanupCallbacks.push(() => {
                        RunningGameStore.getGameForPID = rawGetPid;
                    });
                }
            }
            if (ApplicationStreamingStore) {
                const rawGetStream = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
                if (typeof rawGetStream === "function") {
                    const boundGetStream = rawGetStream.bind(ApplicationStreamingStore);
                    ApplicationStreamingStore.getStreamerActiveStreamMetadata = cloakFunction(function () {
                        return self.getStreamerActiveStreamMetadata() ?? boundGetStream();
                    }, rawGetStream, "getStreamerActiveStreamMetadata");
                    storeCleanupCallbacks.push(() => {
                        ApplicationStreamingStore.getStreamerActiveStreamMetadata = rawGetStream;
                    });
                }
            }
        } catch (err) {
            console.warn("[CompleteDiscordQuest] Failed to install runtime store hooks:", err);
        }
    },
    start() {
        if (!ensureHasAcceptedToUsePlugin()) {
            stopAllFarming();
            return;
        }

        installStackTraceSanitizer();
        scrubCachedSuperProperties();
        this.installRuntimeStoreHooks();
        QuestsStore.addChangeListener(updateQuests);
        updateQuests();
    },
    stop() {
        QuestsStore.removeChangeListener(updateQuests);
        stopAllFarming();
        while (storeCleanupCallbacks.length > 0) {
            try {
                storeCleanupCallbacks.pop()?.();
            } catch {}
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

function isQuestEligibleForFarming(quest: QuestValue): boolean {
    try {
        const questConfig = quest?.config?.taskConfig || quest?.config?.taskConfigV2;
        if (!questConfig?.tasks) return false;
        if (!Object.keys(questConfig.tasks).some(taskName => {
            return (taskName === "WATCH_VIDEO" && settings.store.farmVideos
                || taskName === "WATCH_VIDEO_ON_MOBILE" && settings.store.farmVideos
                || taskName === "PLAY_ON_DESKTOP" && settings.store.farmPlayOnDesktop
                || taskName === "STREAM_ON_DESKTOP" && settings.store.farmStreamOnDesktop
                || taskName === "PLAY_ACTIVITY" && settings.store.farmPlayActivity);
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

        for (const quest of completableQuests) {
            if (!quest?.id || completingQuest.has(quest.id)) continue;
            const tc = quest.config?.taskConfig ?? quest.config?.taskConfigV2;
            if (!tc?.tasks) continue;
            const tName = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"].find(x => tc.tasks[x] != null);
            if (!tName) continue;
            const isVideo = tName === "WATCH_VIDEO" || tName === "WATCH_VIDEO_ON_MOBILE";
            if (isVideo) {
                if (hasActiveVideo) continue;
                hasActiveVideo = true;
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

function acceptQuest(quest: QuestValue) {
    if (!settings.store.acceptQuestsAutomatically || !quest?.id || enrollingQuestIds.has(quest.id)) return;
    try {
        enrollingQuestIds.add(quest.id);
        const questName = quest?.config?.messages?.questName ?? quest.id;
        console.log("Accepting quest:", questName);
        const action: QuestAction = {
            questContent: QuestLocationMap?.QUEST_HOME_DESKTOP ?? 11,
            questContentCTA: "ACCEPT_QUEST",
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
            if (Array.isArray(platforms) && platforms.length > 1) {
                failedClaimQuestIds.add(questId);
                console.log(`[CompleteDiscordQuest] Skipping auto-claim for ${questName} (requires manual platform choice).`);
                continue;
            }
            const platform = Array.isArray(platforms) && platforms.length === 1 ? platforms[0] : 0;
            const location = QuestLocationMap?.QUEST_HOME_DESKTOP ?? 11;

            claimingQuestIds.add(questId);
            let abortQueueOnCaptcha = false;
            try {
                console.log("[CompleteDiscordQuest] Claiming completed quest reward:", questName);
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
        const taskName = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"].find(x => taskConfig.tasks[x] != null);
        if (!taskName) {
            console.log("Unknown task type for quest:", questName);
            completingQuest.set(quest.id, false);
            return;
        }
        const taskData = taskConfig.tasks[taskName] as any;
        const applicationId = quest.config?.application?.id ?? taskData?.applications?.[0]?.id;
        const applicationName = quest.config?.application?.name ?? quest.config?.messages?.gameTitle ?? questName;
        const secondsNeeded = taskData?.target ?? 0;
        let secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;

        if (!isApp && taskName !== "WATCH_VIDEO" && taskName !== "WATCH_VIDEO_ON_MOBILE") {
            console.log("This no longer works in browser for non-video quests (" + taskName + "). Use the discord desktop app to complete the", questName, "quest!");
            completingQuest.set(quest.id, false);
            return;
        }

        const isVideoTask = taskName === "WATCH_VIDEO" || taskName === "WATCH_VIDEO_ON_MOBILE";
        completingQuest.set(quest.id, isVideoTask ? "video" : "game");

        console.log(`Completing quest ${questName} (${quest.id}) - ${taskName} for ${secondsNeeded} seconds.`);

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

            case "PLAY_ACTIVITY": {
                const channelId = ChannelStore?.getSortedPrivateChannels?.()?.[0]?.id
                    ?? (Object.values(GuildChannelStore?.getAllGuilds?.() ?? {}) as any[]).find(x => x != null && Array.isArray(x.VOCAL) && x.VOCAL.length > 0)?.VOCAL?.[0]?.channel?.id;
                const streamKey = channelId ? `call:${channelId}:1` : undefined;

                const playActivity = async () => {
                    try {
                        console.log("Completing quest", questName);

                        while (true) {
                            const body = applicationId
                                ? { application_id: applicationId, terminal: false }
                                : { stream_key: streamKey, terminal: false };
                            let res: any;
                            try {
                                res = await RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body });
                            } catch (hbErr: any) {
                                if (hbErr?.status === 429) {
                                    const retryMs = ((hbErr?.body?.retry_after as number) || 10) * 1000 + 500;
                                    await new Promise(resolve => setTimeout(resolve, retryMs));
                                    continue;
                                }
                                throw hbErr;
                            }
                            const progress = res?.body?.progress?.PLAY_ACTIVITY?.value ?? 0;
                            console.log(`Quest progress ${questName}: ${progress}/${secondsNeeded}`);

                            if (!completingQuest.get(quest.id) || progress >= secondsNeeded || res?.body?.completed_at != null) {
                                console.log("Stopping completing quest:", questName);

                                if (progress >= secondsNeeded || res?.body?.completed_at != null) {
                                    const termBody = applicationId
                                        ? { application_id: applicationId, terminal: true }
                                        : { stream_key: streamKey, terminal: true };
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
                                    console.log("Quest completed!");
                                    completingQuest.set(quest.id, false);
                                }
                                break;
                            }

                            await new Promise(resolve => setTimeout(resolve, (60 * 1000) + Math.floor(Math.random() * 1500)));
                        }
                    } catch (err) {
                        console.error("Error in playActivity for quest:", questName, err);
                        completingQuest.set(quest.id, false);
                    }
                };
                playActivity();
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
