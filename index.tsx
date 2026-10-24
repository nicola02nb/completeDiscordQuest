/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import { FluxDispatcher, RestAPI } from "@webpack/common";

import { QuestButton, QuestsCount } from "./components/QuestButton";
import settings from "./settings";
import { ChannelStore, GuildChannelStore, QuestsStore, RunningGameStore, SuperPropertiesStore, UserStore } from "./stores";

const QuestApplyAction = findByCodeLazy("type:\"QUESTS_ENROLL_BEGIN\"") as (questId: string, action: QuestAction) => Promise<any>;
const QuestLocationMap = findByPropsLazy("QUEST_HOME_DESKTOP", "11") as Record<string, any>;

let availableQuests: QuestValue[] = [];
let acceptableQuests: QuestValue[] = [];
let completableQuests: QuestValue[] = [];

const completingQuest = new Map();
const fakeGames = new Map();
const fakeApplications = new Map();

// 12 client-mod / DevTools detection bits in libdiscore-wasm generateLaunchSignature (MSB-first 0..127)
const CLIENT_MOD_DETECTION_BITS = [0, 19, 27, 36, 43, 52, 66, 72, 79, 89, 103, 116];

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
        const props = SuperPropertiesStore?.getSuperProperties?.();
        if (props?.launch_signature) {
            props.launch_signature = scrubLaunchSignatureUuid(props.launch_signature);
        }
        if (props && "has_client_mods" in props) {
            props.has_client_mods = false;
        }
    } catch {}
}

function installStackTraceSanitizer() {
    if (restoreStackGetter) return;
    try {
        const origDesc = Object.getOwnPropertyDescriptor(Error.prototype, "stack");
        if (origDesc?.get && !(origDesc.get as any).__stealthPatched) {
            const origGet = origDesc.get;
            const cleanGet = function (this: Error) {
                const raw = origGet.call(this);
                if (typeof raw !== "string") return raw;
                return raw
                    .split("\n")
                    .filter(line => !/vencord|betterdiscord|completediscordquest|<anonymous>|eval at/i.test(line))
                    .join("\n");
            };
            (cleanGet as any).__stealthPatched = true;
            Object.defineProperty(Error.prototype, "stack", { ...origDesc, get: cleanGet });
            restoreStackGetter = () => {
                Object.defineProperty(Error.prototype, "stack", origDesc);
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

// Exact port of discord_utils.node sub_a3990 + sub_a4120 + sub_1350 (146-byte 0x92 struct -> 196-char Base64 executableFingerprint)
async function synthesizeSignedExecutableFingerprint(userId: string, appId: string, exePath: string, realGames: any[] = []): Promise<string> {
    const enc = new TextEncoder();
    const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));

    const xorKey = await sha256(String(userId ?? "") + "https://discord.com/careers");

    let harvestedHw: Uint8Array | null = null;
    try {
        const candidates = [
            ...realGames,
            ...(RunningGameStore?.getGamesSeen?.(false) ?? []),
            ...(RunningGameStore?.getCandidateGames?.() ?? [])
        ];
        const existingFp = candidates.find(g => typeof g?.executableFingerprint === "string" && g.executableFingerprint.length === 196)?.executableFingerprint;
        if (existingFp) {
            const raw = Uint8Array.from(atob(existingFp), c => c.charCodeAt(0));
            if (raw.length === 0x92 && raw[0] === 0x01) {
                const plain = new Uint8Array(0x92);
                plain[0] = raw[0];
                for (let i = 1; i < 0x92; i++) plain[i] = raw[i] ^ xorKey[(i - 1) & 31];
                if ((plain[1] & 0x01) !== 0) {
                    harvestedHw = plain.slice(0x32, 0x52);
                }
            }
        }
    } catch {}

    const seed = `${appId}:${formatQuestExecutablePath(exePath) ?? exePath}`;
    const seedHash = await sha256("seed:" + seed);
    const seedView = new DataView(seedHash.buffer);

    const baseMb = 48 + (seedView.getUint32(0, true) % 92);
    const extraBytes = (seedView.getUint32(4, true) % 1024) * 512;
    const fileSize = BigInt(baseMb * 1024 * 1024 + extraBytes);
    const timeDateStamp = (1704067200 + (seedView.getUint32(8, true) % 55000000)) >>> 0;
    const pages = 0x3800 + (seedView.getUint16(12, true) % 0x4000);
    const sizeOfImage = (pages * 0x1000) >>> 0;

    const hPeHeaders = await sha256(`PE_HEADERS_V1:${seed}:${timeDateStamp}:${sizeOfImage}`);
    const hHw = await sha256("hw:" + navigator.userAgent + ":" + (navigator.hardwareConcurrency || 8) + ":" + String(userId ?? ""));
    const hSections = await sha256(`PE_SECTIONS_V1:${seed}:${sizeOfImage}`);
    const hCert = await sha256(`AUTHENTICODE_CERT_V1:${seed}`);

    const buf = new Uint8Array(0x92);
    const pktView = new DataView(buf.buffer);
    buf[0x00] = 0x01; // Version = 1 (un-XORed in sub_1350)
    buf[0x01] = 0x03; // Flags = is_signed (0x01) | is_pe64 (0x02)
    pktView.setBigUint64(0x02, fileSize, true);
    pktView.setUint32(0x0A, timeDateStamp, true);
    pktView.setUint32(0x0E, sizeOfImage, true);
    buf.set(hPeHeaders, 0x12);
    buf.set(harvestedHw && harvestedHw.length === 32 ? harvestedHw : hHw, 0x32);
    buf.set(hSections, 0x52);
    buf.set(hCert, 0x72);

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
            find: "\"RunningGameStore\"",
            group: true,
            replacement: [
                {
                    match: /}getRunningGames\(\){return ([^}]+)}/,
                    replace: "}getRunningGames(){return $self.getRunningGames($1)}"
                },
                {
                    match: /}getGameForPID\((\i)\){/,
                    replace: "}getGameForPID($1){const pid=$self.getGameForPID($1);if(pid){return pid;}"
                }
            ]
        },
        {
            find: "ApplicationStreamingStore",
            replacement: {
                match: /}getStreamerActiveStreamMetadata\(\){/,
                replace: "}getStreamerActiveStreamMetadata(){const metadata=$self.getStreamerActiveStreamMetadata();if(metadata){return metadata;}"
            }
        },
        {
            find: "launchSignature:",
            replacement: {
                match: /launchSignature:(\i)\(\)/,
                replace: "launchSignature:$self.scrubLaunchSignature($1())"
            }
        }
    ],
    start: () => {
        if (!ensureHasAcceptedToUsePlugin()) {
            stopAllFarming();
            return;
        }

        installStackTraceSanitizer();
        scrubCachedSuperProperties();
        QuestsStore.addChangeListener(updateQuests);
        updateQuests();
    },
    stop: () => {
        QuestsStore.removeChangeListener(updateQuests);
        stopAllFarming();
        if (restoreStackGetter) {
            restoreStackGetter();
        }
    },

    scrubLaunchSignature(sig: string) {
        return scrubLaunchSignatureUuid(sig);
    },

    renderQuestButtonTopBar() {
        if (settings.store.showQuestsButtonTopBar) {
            return <QuestButton type="top-bar" />;
        }
    },

    renderQuestButtonSettingsBar() {
        if (settings.store.showQuestsButtonSettingsBar) {
            return <QuestButton type="settings-bar" />;
        }
    },

    renderQuestButtonBadges(questButton) {
        if (settings.store.showQuestsButtonBadges && typeof questButton === "string" && questButton === "quests") {
            return (<QuestsCount />);
        }
        // Experiment
        if (settings.store.showQuestsButtonBadges && questButton?.href?.startsWith("/quest-home")
            && Array.isArray(questButton?.children) && questButton.children.findIndex(child => child?.type === QuestsCount) === -1) {
            questButton.children.push(<QuestsCount />);
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
            if (!merged.some(g => g && (String(g.id) === String(fake.id) || g.pid === fake.pid))) {
                merged.push(fake);
            }
        }
        return merged;
    },

    getGameForPID(pid) {
        if (fakeGames.size > 0) {
            return Array.from(fakeGames.values()).find(game => game.pid === pid);
        }
    },

    getStreamerActiveStreamMetadata() {
        if (fakeApplications.size > 0) {
            return Array.from(fakeApplications.values()).at(0);
        }
    }
});

function isQuestEligibleForFarming(quest: QuestValue): boolean {
    const questConfig = quest.config.taskConfig || quest.config.taskConfigV2;
    if (!Object.keys(questConfig.tasks).some(taskName => {
        return (taskName === "WATCH_VIDEO" && settings.store.farmVideos
            || taskName === "WATCH_VIDEO_ON_MOBILE" && settings.store.farmVideos
            || taskName === "PLAY_ON_DESKTOP" && settings.store.farmPlayOnDesktop
            || taskName === "STREAM_ON_DESKTOP" && settings.store.farmStreamOnDesktop
            || taskName === "PLAY_ACTIVITY" && settings.store.farmPlayActivity);
    })) return false;

    const rewards = quest.config?.rewardsConfig?.rewards || [];
    if (!Array.isArray(rewards) || rewards.length === 0) return false;
    return rewards.some(reward => {
        return (reward.type === 1 && settings.store.farmRewardCodes
            || reward.type === 2 && settings.store.farmInGame
            || reward.type === 3 && settings.store.farmCollectibles
            || reward.type === 4 && settings.store.farmVirtualCurrency
            || reward.type === 5 && settings.store.farmFractionalPremium);
    });
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
    if (!settings.store.hasAcceptedToUsePlugin) {
        stopAllFarming();
        console.warn("Consent not accepted. Skipping quest update/completion.");
        return;
    }

    scrubCachedSuperProperties();
    availableQuests = [...QuestsStore.quests.values()];
    acceptableQuests = availableQuests.filter(x => x.userStatus?.enrolledAt == null && new Date(x.config.expiresAt).getTime() > Date.now()) || [];
    completableQuests = availableQuests.filter(x => x.userStatus?.enrolledAt && !x.userStatus?.completedAt && new Date(x.config.expiresAt).getTime() > Date.now()) || [];
    for (const quest of acceptableQuests) {
        if (isQuestEligibleForFarming(quest)) {
            acceptQuest(quest);
        }
    }
    for (const quest of completableQuests) {
        if (completingQuest.has(quest.id)) {
            if (completingQuest.get(quest.id) === false) {
                completingQuest.delete(quest.id);
            }
        } else {
            completeQuest(quest);
        }
    }
}

function acceptQuest(quest: QuestValue) {
    if (!settings.store.acceptQuestsAutomatically) return;
    console.log("Accepting quest:", quest.config.messages.questName);
    const action: QuestAction = {
        questContent: QuestLocationMap.QUEST_HOME_DESKTOP,
        questContentCTA: "ACCEPT_QUEST",
        sourceQuestContent: 0,
    };
    QuestApplyAction(quest.id, action).then(() => {
        console.log("Accepted quest:", quest.config.messages.questName);
    }).catch(err => {
        console.error("Failed to accept quest:", quest.config.messages.questName, err);
    });
}

function stopCompletingAll() {
    for (const quest of completableQuests) {
        if (completingQuest.has(quest.id)) {
            completingQuest.set(quest.id, false);
        }
    }
    console.log("Stopped completing all quests.");
}

function stopAllFarming() {
    stopCompletingAll();

    if (fakeGames.size > 0) {
        const removedGames = Array.from(fakeGames.values());
        fakeGames.clear();
        const games = RunningGameStore.getRunningGames();
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

    const isApp = typeof DiscordNative !== "undefined";
    if (!quest) {
        console.log("You don't have any uncompleted quests!");
    } else {
        // Windows PIDs are always multiples of 4; use a separate small observer ID (1..32)
        const pid = (Math.floor(Math.random() * 7500) + 1000) * 4;
        const observerId = ((nextObserverId++ - 1) % 32) + 1;

        const applicationId = quest.config.application.id;
        const applicationName = quest.config.application.name;
        const { questName } = quest.config.messages;
        const taskConfig = quest.config.taskConfig ?? quest.config.taskConfigV2;
        const taskName = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"].find(x => taskConfig.tasks[x] != null);
        if (!taskName) {
            console.log("Unknown task type for quest:", questName);
            return;
        }
        const secondsNeeded = taskConfig.tasks[taskName].target;
        let secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;

        if (!isApp && taskName !== "WATCH_VIDEO" && taskName !== "WATCH_VIDEO_ON_MOBILE") {
            console.log("This no longer works in browser for non-video quests (" + taskName + "). Use the discord desktop app to complete the", questName, "quest!");
            return;
        }

        completingQuest.set(quest.id, true);

        console.log(`Completing quest ${questName} (${quest.id}) - ${taskName} for ${secondsNeeded} seconds.`);

        switch (taskName) {
            case "WATCH_VIDEO":
            case "WATCH_VIDEO_ON_MOBILE":
                // Real-time 1x pacing (10s advance per ~10s interval) anchored to session start
                const maxFuture = 8, speed = 10, interval = 10;
                const enrolledAt = new Date(quest.userStatus.enrolledAt).getTime();
                const sessionStartMs = Date.now();
                const initialProgress = secondsDone;
                let completed = false;
                const watchVideo = async () => {
                    while (true) {
                        const anchorMs = Math.max(enrolledAt, sessionStartMs - maxFuture * 1000);
                        const maxAllowed = initialProgress + Math.floor((Date.now() - anchorMs) / 1000) + maxFuture;
                        const diff = maxAllowed - secondsDone;
                        const timestamp = Math.min(secondsNeeded, secondsDone + speed);

                        if (!completingQuest.get(quest.id)) {
                            console.log("Stopping completing quest:", questName);
                            completingQuest.set(quest.id, false);
                            break;
                        }

                        if (diff >= speed || timestamp >= secondsNeeded) {
                            const jitter = 0.12 + Math.random() * 0.76;
                            const reqBody = { timestamp: Number(Math.min(secondsNeeded - 0.01, timestamp + jitter).toFixed(3)) };
                            const res = await RestAPI.post({ url: `/quests/${quest.id}/video-progress`, body: reqBody });
                            completed = res.body?.completed_at != null;
                            secondsDone = Math.min(secondsNeeded, Math.floor(reqBody.timestamp));
                        }

                        if (completed || secondsDone >= secondsNeeded - 1) {
                            completingQuest.set(quest.id, false);
                            break;
                        }
                        const jitterMs = Math.floor(Math.random() * 1500);
                        await new Promise(resolve => setTimeout(resolve, interval * 1000 + jitterMs));
                    }
                    if (!completed) {
                        const finalTs = Number((secondsNeeded - (0.02 + Math.random() * 0.15)).toFixed(3));
                        await RestAPI.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: finalTs } });
                    }
                    console.log("Quest completed!");
                };
                watchVideo();
                console.log(`Spoofing video for ${questName} (1x real-time stealth pacing).`);
                break;

            case "PLAY_ON_DESKTOP":
                RestAPI.get({ url: `/applications/public?application_ids=${applicationId}` }).then(async res => {
                    const appData = res.body[0];
                    const rawExe = appData.executables?.find(x => x.os === "win32")?.name?.replace(/^>+/, "") ?? `${appData.name.replace(/[\/\\:*?"<>|]/g, "")}.exe`;
                    const cleanAppFolder = appData.name.replace(/[\/\\:*?"<>|]/g, "").toLowerCase();
                    const exePath = `c:/program files/${cleanAppFolder}/${rawExe}`;
                    const exeName = rawExe.split(/[\/\\]/).pop() || rawExe;
                    const currentRealGames = RunningGameStore.getRunningGames() ?? [];
                    const currentUserId = UserStore?.getCurrentUser?.()?.id ?? "";
                    const executableFingerprint = await synthesizeSignedExecutableFingerprint(currentUserId, applicationId, exePath, currentRealGames);

                    const fakeGame = {
                        cmdLine: `"C:\\Program Files\\${appData.name}\\${rawExe.replace(/\//g, "\\")}"`,
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
                        name: appData.name,
                        nativeProcessObserverId: observerId,
                        origGameName: appData.name,
                        pid: pid,
                        pidPath: [pid],
                        processName: exeName.replace(/\.exe$/i, ""),
                        sandboxed: false,
                        sku: null,
                        start: Date.now() - Math.floor(Math.random() * 8000 + 2000),
                        windowHandle: String(pid * 4 + 65536),
                    };
                    fakeGames.set(quest.id, fakeGame);
                    const mergedGames = RunningGameStore.getRunningGames();
                    FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [], added: [fakeGame], games: mergedGames });

                    const playOnDesktop = event => {
                        if (event.questId !== quest.id) return;
                        const progress = quest.config.configVersion === 1 ? event.userStatus.streamProgressSeconds : Math.floor(event.userStatus.progress.PLAY_ON_DESKTOP.value);
                        console.log(`Quest progress ${questName}: ${progress}/${secondsNeeded}`);

                        if (!completingQuest.get(quest.id) || progress >= secondsNeeded) {
                            console.log("Stopping completing quest:", questName);

                            fakeGames.delete(quest.id);
                            const games = RunningGameStore.getRunningGames();
                            FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games });
                            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", playOnDesktop);

                            if (progress >= secondsNeeded) {
                                console.log("Quest completed!");
                                completingQuest.set(quest.id, false);
                            }
                        }
                    };
                    FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", playOnDesktop);

                    console.log(`Spoofed your game to ${applicationName} (path: ${formatQuestExecutablePath(exePath)}, 196-char signed executableFingerprint attached). Wait for ${Math.ceil((secondsNeeded - secondsDone) / 60)} more minutes.`);
                });
                break;

            case "STREAM_ON_DESKTOP":
                const fakeApp = {
                    id: applicationId,
                    name: applicationName,
                    pid: pid,
                    sourceName: null,
                };
                fakeApplications.set(quest.id, fakeApp);

                const streamOnDesktop = event => {
                    if (event.questId !== quest.id) return;
                    const progress = quest.config.configVersion === 1 ? event.userStatus.streamProgressSeconds : Math.floor(event.userStatus.progress.STREAM_ON_DESKTOP.value);
                    console.log(`Quest progress ${questName}: ${progress}/${secondsNeeded}`);

                    if (!completingQuest.get(quest.id) || progress >= secondsNeeded) {
                        console.log("Stopping completing quest:", questName);

                        fakeApplications.delete(quest.id);
                        FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", streamOnDesktop);

                        if (progress >= secondsNeeded) {
                            console.log("Quest completed!");
                            completingQuest.set(quest.id, false);
                        }
                    }
                };
                FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", streamOnDesktop);

                console.log(`Spoofed your stream to ${applicationName}. Stream any window in vc for ${Math.ceil((secondsNeeded - secondsDone) / 60)} more minutes.`);
                console.log("Remember that you need at least 1 other person to be in the vc!");
                break;

            case "PLAY_ACTIVITY":
                const channelId = ChannelStore.getSortedPrivateChannels()[0]?.id ?? Object.values(GuildChannelStore.getAllGuilds()).find(x => x != null && x.VOCAL.length > 0)?.VOCAL?.[0]?.channel?.id;
                const streamKey = channelId ? `call:${channelId}:1` : undefined;

                const playActivity = async () => {
                    console.log("Completing quest", questName, "-", quest.config.messages.questName);

                    while (true) {
                        const body = applicationId
                            ? { application_id: applicationId, terminal: false }
                            : { stream_key: streamKey, terminal: false };
                        const res = await RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body });
                        const progress = res.body?.progress?.PLAY_ACTIVITY?.value ?? 0;
                        console.log(`Quest progress ${questName}: ${progress}/${secondsNeeded}`);

                        if (!completingQuest.get(quest.id) || progress >= secondsNeeded || res.body?.completed_at != null) {
                            console.log("Stopping completing quest:", questName);

                            if (progress >= secondsNeeded || res.body?.completed_at != null) {
                                const termBody = applicationId
                                    ? { terminal: true }
                                    : { stream_key: streamKey, terminal: true };
                                await RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body: termBody });
                                console.log("Quest completed!");
                                completingQuest.set(quest.id, false);
                            }
                            break;
                        }

                        await new Promise(resolve => setTimeout(resolve, (60 * 1000) + Math.floor(Math.random() * 1500)));
                    }
                };
                playActivity();
                break;

            default:
                console.error("Unknown task type:", taskName);
                completingQuest.set(quest.id, false);
                break;
        }
    }
}
