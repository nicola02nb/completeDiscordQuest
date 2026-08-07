/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { PluginNative } from "@utils/types";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import { FluxDispatcher, RestAPI } from "@webpack/common";

import { QuestButton, QuestsCount } from "./components/QuestButton";
import settings from "./settings";
import { ChannelStore, GuildChannelStore, QuestsStore, RunningGameStore, UserStore } from "./stores";

const Native = VencordNative.pluginHelpers.CompleteDiscordQuest as PluginNative<typeof import("./native")>;

const QuestApplyAction = findByCodeLazy("type:\"QUESTS_ENROLL_BEGIN\"") as (questId: string, action: QuestAction) => Promise<any>;
const QuestLocationMap = findByPropsLazy("QUEST_HOME_DESKTOP", "11") as Record<string, any>;
const supportedTasks = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE", "ACHIEVEMENT_IN_ACTIVITY"] as const;

let availableQuests: QuestValue[] = [];
let acceptableQuests: QuestValue[] = [];
let completableQuests: QuestValue[] = [];

const completingQuest = new Map();
const fakeGames = new Map();
const fakeApplications = new Map();

export default definePlugin({
    name: "CompleteDiscordQuest",
    description: "A plugin that completes multiple discord quests in background simultaneously.",
    authors: [Devs.nicola02nb, Devs.nyx, Devs.djdoolky76],
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
                    match: /}getRunningGames\(\){return/,
                    replace: "}getRunningGames(){const games=$self.getRunningGames();return games ? games : "
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
        }
    ],
    start: () => {
        QuestsStore.addChangeListener(updateQuests);
        updateQuests();
    },
    stop: () => {
        QuestsStore.removeChangeListener(updateQuests);
        stopCompletingAll();
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

    getRunningGames() {
        if (fakeGames.size > 0) {
            return Array.from(fakeGames.values());
        }
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
    if (!questConfig?.tasks) return false;

    if (!Object.keys(questConfig.tasks).some(taskName => {
        return (taskName === "WATCH_VIDEO" && settings.store.farmVideos
            || taskName === "WATCH_VIDEO_ON_MOBILE" && settings.store.farmVideos
            || taskName === "PLAY_ON_DESKTOP" && settings.store.farmPlayOnDesktop
            || taskName === "STREAM_ON_DESKTOP" && settings.store.farmStreamOnDesktop
            || taskName === "PLAY_ACTIVITY" && settings.store.farmPlayActivity
            || taskName === "ACHIEVEMENT_IN_ACTIVITY" && settings.store.farmAchievement);
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

function updateQuests() {
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
    /* console.log("Available quests updated:", availableQuests);
    console.log("Acceptable quests updated:", acceptableQuests);
    console.log("Completable quests updated:", completableQuests); */
}

function acceptQuest(quest: QuestValue) {
    if (!settings.store.acceptQuestsAutomatically) return;
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

function completeQuest(quest: QuestValue) {
    const isApp = typeof DiscordNative !== "undefined";
    if (!quest) {
        console.log("You don't have any uncompleted quests!");
    } else {
        const pid = Math.floor(Math.random() * 30000) + 1000;

        const { questName } = quest.config.messages;
        const taskConfig = quest.config.taskConfig ?? quest.config.taskConfigV2;
        if (!taskConfig?.tasks) {
            console.log("Quest has no task configuration:", questName);
            return;
        }

        const taskName = supportedTasks.find(x => taskConfig.tasks[x] != null);
        if (!taskName) {
            console.log("Unknown task type for quest:", questName);
            return;
        }
        const taskData = taskConfig.tasks[taskName];
        if (!taskData) return;

        const applicationId = quest.config.application?.id ?? taskData.applications?.[0]?.id;
        const applicationName = quest.config.application?.name ?? taskData.applications?.[0]?.name ?? questName;
        const secondsNeeded = taskData.target;
        let secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;

        if ((taskName === "PLAY_ON_DESKTOP" || taskName === "STREAM_ON_DESKTOP") && !applicationId) {
            console.error("Quest is missing an application ID:", questName);
            return;
        }

        if (!isApp && taskName !== "WATCH_VIDEO" && taskName !== "WATCH_VIDEO_ON_MOBILE") {
            console.log("This no longer works in browser for non-video quests (" + taskName + "). Use the discord desktop app to complete the", questName, "quest!");
            return;
        }

        completingQuest.set(quest.id, true);

        console.log(`Completing quest ${questName} (${quest.id}) - ${taskName} for ${secondsNeeded} seconds.`);

        switch (taskName) {
            case "WATCH_VIDEO":
            case "WATCH_VIDEO_ON_MOBILE":
                const speed = 7;
                let completed = false;
                const watchVideo = async () => {
                    while (secondsDone < secondsNeeded) {
                        if (!completingQuest.get(quest.id)) {
                            console.log("Stopping completing quest:", questName);
                            return;
                        }

                        const remaining = Math.min(speed, secondsNeeded - secondsDone);
                        await new Promise(resolve => setTimeout(resolve, remaining * 1000));

                        if (!completingQuest.get(quest.id)) {
                            console.log("Stopping completing quest:", questName);
                            return;
                        }

                        const timestamp = Math.min(secondsNeeded, secondsDone + speed);
                        const res = await RestAPI.post({
                            url: `/quests/${quest.id}/video-progress`,
                            body: { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) }
                        });
                        completed = res.body.completed_at != null;
                        secondsDone = timestamp;

                        if (completed) {
                            break;
                        }
                    }
                    if (!completed) {
                        await RestAPI.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: secondsNeeded } });
                    }
                    completingQuest.set(quest.id, false);
                    console.log("Quest completed!");
                };
                watchVideo();
                console.log(`Spoofing video for ${questName}.`);
                break;

            case "PLAY_ON_DESKTOP":
                RestAPI.get({ url: `/applications/public?application_ids=${applicationId}` }).then(res => {
                    const appData = res.body[0];
                    const exeName = appData.executables?.find(x => x.os === "win32")?.name?.replace(">", "") ?? appData.name.replace(/[/\\:*?"<>|]/g, "");

                    const fakeGame = {
                        cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`,
                        exeName,
                        exePath: `c:/program files/${appData.name.toLowerCase()}/${exeName}`,
                        hidden: false,
                        isLauncher: false,
                        id: applicationId,
                        name: appData.name,
                        pid: pid,
                        pidPath: [pid],
                        processName: appData.name,
                        start: Date.now(),
                    };
                    const realGames = fakeGames.size === 0 ? RunningGameStore.getRunningGames() : [];
                    fakeGames.set(quest.id, fakeGame);
                    const fakeGames2 = Array.from(fakeGames.values());
                    FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: realGames, added: [fakeGame], games: fakeGames2 });

                    const playOnDesktop = event => {
                        const eventQuestId = event.questId ?? event.userStatus?.questId;
                        if (eventQuestId != null && eventQuestId !== quest.id) return;
                        const progress = quest.config.configVersion === 1 ? event.userStatus.streamProgressSeconds : Math.floor(event.userStatus.progress.PLAY_ON_DESKTOP.value);
                        console.log(`Quest progress ${questName}: ${progress}/${secondsNeeded}`);

                        if (!completingQuest.get(quest.id) || progress >= secondsNeeded) {
                            console.log("Stopping completing quest:", questName);

                            fakeGames.delete(quest.id);
                            const games = RunningGameStore.getRunningGames();
                            const added = fakeGames.size === 0 ? games : [];
                            FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: added, games: games });
                            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", playOnDesktop);

                            if (progress >= secondsNeeded) {
                                console.log("Quest completed!");
                                completingQuest.set(quest.id, false);
                            }
                        }
                    };
                    FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", playOnDesktop);

                    console.log(`Spoofed your game to ${applicationName}. Wait for ${Math.ceil((secondsNeeded - secondsDone) / 60)} more minutes.`);
                });
                break;

            case "STREAM_ON_DESKTOP":
                const fakeApp = {
                    id: applicationId,
                    name: `FakeApp ${applicationName} (CompleteDiscordQuest)`,
                    pid: pid,
                    sourceName: null,
                };
                fakeApplications.set(quest.id, fakeApp);

                const streamOnDesktop = event => {
                    const eventQuestId = event.questId ?? event.userStatus?.questId;
                    if (eventQuestId != null && eventQuestId !== quest.id) return;
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
                const channelId = ChannelStore.getSortedPrivateChannels()[0]?.id ?? Object.values(GuildChannelStore.getAllGuilds()).find(x => x != null && x.VOCAL.length > 0).VOCAL[0].channel.id;
                const streamKey = `call:${channelId}:1`;

                const playActivity = async () => {
                    console.log("Completing quest", questName, "-", quest.config.messages.questName);

                    while (true) {
                        const res = await RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, application_id: String(applicationId || ""), terminal: false } });
                        const progress = res.body.progress.PLAY_ACTIVITY.value;
                        console.log(`Quest progress ${questName}: ${progress}/${secondsNeeded}`);

                        await new Promise(resolve => setTimeout(resolve, 20 * 1000));

                        if (!completingQuest.get(quest.id) || progress >= secondsNeeded) {
                            console.log("Stopping completing quest:", questName);

                            if (progress >= secondsNeeded) {
                                await RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: true } });
                                console.log("Quest completed!");
                                completingQuest.set(quest.id, false);
                            }
                            break;
                        }
                    }
                };
                playActivity();
                break;

            case "ACHIEVEMENT_IN_ACTIVITY":
                const achievementKey = getStreamKey();
                if (!achievementKey) {
                    console.error("No voice channel found for achievement heartbeat. Trying bypass directly.");
                }

                const completeAchievement = async () => {
                    let achievementDone = false;

                    // Phase 1: Try heartbeat spoof (works for some quests; most ACHIEVEMENT_IN_ACTIVITY
                    // quests will return 403 and fall through to Phase 2 immediately).
                    if (achievementKey) {
                        const beat = { stream_key: achievementKey, application_id: String(applicationId || ""), terminal: false };
                        let cur: number = quest.userStatus?.progress?.[taskName]?.value ?? 0;
                        let failCount = 0;
                        console.log(`[Achievement] Attempting heartbeat for "${questName}" (${cur}/${secondsNeeded})...`);

                        while (cur < secondsNeeded && completingQuest.get(quest.id)) {
                            try {
                                const r = await RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body: beat });
                                const newCur: number = r.body?.progress?.[taskName]?.value ?? r.body?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value ?? cur;
                                if (newCur > cur) {
                                    cur = newCur;
                                    console.log(`[Achievement] "${questName}" progress: ${cur}/${secondsNeeded}`);
                                }
                                failCount = 0;
                                if (cur >= secondsNeeded) {
                                    try { await RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body: { ...beat, terminal: true } }); }
                                    catch { /* noop */ }
                                    achievementDone = true;
                                    break;
                                }
                            } catch (e: any) {
                                failCount++;
                                if (e?.status && [400, 403, 404, 409, 410].includes(e.status)) {
                                    console.warn(`[Achievement] Heartbeat rejected (HTTP ${e.status}). Falling back to bypass.`);
                                    break;
                                }
                                if (failCount >= 3) {
                                    console.warn("[Achievement] Too many heartbeat failures. Falling back to bypass.");
                                    break;
                                }
                            }
                            await new Promise(resolve => setTimeout(resolve, 20 * 1000));
                        }
                    }

                    // Phase 2: If heartbeat didn't finish, try Discord Says OAuth bypass
                    if (!achievementDone && completingQuest.get(quest.id)) {
                        if (!settings.store.farmAchievement) {
                            console.warn(`[Achievement] OAuth bypass is off in settings; skipping "${questName}". Enable 'Farm Achievement' to allow this.`);
                            completingQuest.set(quest.id, false);
                            return;
                        }

                        const isApp = typeof DiscordNative !== "undefined";
                        if (!isApp) {
                            console.warn(`[Achievement] OAuth bypass requires the desktop app. Cannot complete "${questName}" in browser.`);
                            completingQuest.set(quest.id, false);
                            return;
                        }

                        const appId = String(applicationId || "");
                        if (!appId || !/^\d+$/.test(appId)) {
                            console.error(`[Achievement] No valid application ID for "${questName}". Cannot bypass.`);
                            completingQuest.set(quest.id, false);
                            return;
                        }

                        console.log(`[Achievement] Trying Discord Says OAuth bypass for "${questName}"...`);
                        achievementDone = await bypassAchievement(quest.id, appId, secondsNeeded);
                    }

                    if (achievementDone) {
                        console.log(`[Achievement] Quest "${questName}" completed!`);
                    } else {
                        console.warn(`[Achievement] Could not complete "${questName}". Both heartbeat and bypass failed.`);
                    }
                    completingQuest.set(quest.id, false);
                };
                completeAchievement();
                break;

            default:
                console.error("Unknown task type:", taskName);
                completingQuest.set(quest.id, false);
                break;
        }
    }
}

/**
 * Build a stream key for heartbeat spoofing.
 * Uses the current user's ID as the owner, and picks the first available
 * DM channel or guild voice channel.
 */
function getStreamKey(): string | null {
    try {
        const ownerId = UserStore.getCurrentUser()?.id;
        if (!ownerId) return null;

        const dmChan = ChannelStore.getSortedPrivateChannels()?.[0]?.id;
        if (dmChan) return `call:${dmChan}:${ownerId}`;

        const guilds = GuildChannelStore.getAllGuilds() ?? {};
        for (const g of Object.values<any>(guilds)) {
            const voiceChan = g?.VOCAL?.[0]?.channel;
            if (voiceChan?.id) {
                const guildId = voiceChan.guild_id ?? g?.id;
                if (guildId) return `guild:${guildId}:${voiceChan.id}:${ownerId}`;
            }
        }
        return null;
    } catch (e: any) {
        console.error("[Achievement] Stream key lookup error:", e?.message);
        return null;
    }
}

/**
 * OAuth2 → discordsays.com bypass for ACHIEVEMENT_IN_ACTIVITY.
 * Flow:
 *   1) Snapshot existing OAuth grants for the app
 *   2) /oauth2/authorize the quest's app (returns code in location URL)
 *   3) /applications/{appId}/proxy-tickets (returns proxy ticket)
 *   4) POST {appId}.discordsays.com/.proxy/acf/authorize {code} → DS token
 *   5) POST {appId}.discordsays.com/.proxy/acf/quest/progress {progress: target}
 *   6) Revoke only the grant we created
 */
async function bypassAchievement(questId: string, appId: string, target: number): Promise<boolean> {
    // Snapshot grants before authorizing so cleanup only revokes what we create
    let preGrantIds: Set<string> | undefined;
    try {
        const before: any = await RestAPI.get({ url: "/oauth2/tokens" });
        preGrantIds = new Set(
            (before?.body || []).filter((tk: any) => tk.application?.id === appId).map((tk: any) => tk.id)
        );
    } catch (e: any) {
        console.warn("[Achievement] Couldn't snapshot existing grants; aborting:", e?.message);
        return false;
    }

    try {
        // Step 1: Authorize the quest app
        const authRes: any = await RestAPI.post({
            url: "/oauth2/authorize",
            query: {
                response_type: "code",
                client_id: appId,
                scope: "identify applications.commands applications.entitlements"
            },
            body: {
                permissions: "0",
                authorize: true,
                integration_type: 1,
                location_context: { guild_id: "10000", channel_id: "10000", channel_type: 10000 }
            }
        });
        const location: string | undefined = authRes?.body?.location;
        if (!location) throw new Error("no location in /oauth2/authorize response");
        const authCode = new URL(location).searchParams.get("code");
        if (!authCode) throw new Error("no code in authorize location");

        // Step 2: Get proxy ticket
        const ticketRes: any = await RestAPI.post({ url: `/applications/${appId}/proxy-tickets`, body: {} });
        const proxyTicket: string | undefined = ticketRes?.body?.ticket;
        if (!proxyTicket) throw new Error("no proxy ticket");

        const referrer = `https://${appId}.discordsays.com/?instance_id=example-cl-instance&platform=desktop&discord_proxy_ticket=${encodeURIComponent(proxyTicket)}`;

        // Step 3: Authorize with Discord Says (via native IPC to bypass CSP)
        const dsAuthRes = await Native.discordsaysAuthorize({ appId, questId, authCode, referrer });
        if (!dsAuthRes.ok) throw new Error(`discordsays authorize ${dsAuthRes.status}`);
        let dsToken: string | undefined;
        try { dsToken = (JSON.parse(dsAuthRes.body) as { token?: string }).token; }
        catch { throw new Error("discordsays returned non-JSON: " + String(dsAuthRes.body).slice(0, 120)); }
        if (!dsToken) throw new Error("no discordsays token");

        // Step 4: Report progress
        const progRes = await Native.discordsaysProgress({ appId, questId, token: dsToken, target, referrer });
        if (!progRes.ok) throw new Error(`discordsays progress ${progRes.status}`);

        console.log(`[Achievement] OAuth bypass succeeded for quest ${questId}.`);
        return true;
    } catch (e: any) {
        const code = e?.body?.code;
        if (code === 50165) {
            console.warn("[Achievement] Activity is age-gated or delisted. Discord blocks the proxy ticket.");
            return false;
        }
        console.error("[Achievement] OAuth bypass failed:", e?.message ?? e);
        return false;
    } finally {
        // Cleanup: revoke only the grant we created
        if (preGrantIds) {
            try {
                const after: any = await RestAPI.get({ url: "/oauth2/tokens" });
                const ours = (after?.body || []).filter(
                    (tk: any) => tk.application?.id === appId && !preGrantIds!.has(tk.id)
                );
                for (const g of ours) {
                    await RestAPI.del({ url: `/oauth2/tokens/${g.id}` });
                }
            } catch (e: any) {
                console.warn("[Achievement] Deauthorize cleanup failed (non-fatal):", e?.message);
            }
        }
    }
}
