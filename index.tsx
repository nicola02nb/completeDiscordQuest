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
import { ChannelStore, GuildChannelStore, QuestsStore, RunningGameStore } from "./stores";

const QuestApplyAction = findByCodeLazy("type:\"QUESTS_ENROLL_BEGIN\"") as (questId: string, action: QuestAction) => Promise<any>;
const QuestLocationMap = findByPropsLazy("QUEST_HOME_DESKTOP", "11") as Record<string, any>;

let availableQuests: QuestValue[] = [];
let acceptableQuests: QuestValue[] = [];
let completableQuests: QuestValue[] = [];

const completingQuest = new Map();
const fakeGames = new Map();
const fakeApplications = new Map();

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
    description: "A plugin that completes multiple discord quests in background simultaneously.",
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
        if (!ensureHasAcceptedToUsePlugin()) {
            stopAllFarming();
            return;
        }

        QuestsStore.addChangeListener(updateQuests);
        updateQuests();
    },
    stop: () => {
        QuestsStore.removeChangeListener(updateQuests);
        stopAllFarming();
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
        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: removedGames, added: games, games });
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
        const pid = Math.floor(Math.random() * 30000) + 1000;

        const { questName } = quest.config.messages;
        const taskConfig = quest.config.taskConfig ?? quest.config.taskConfigV2;
        const taskName = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"].find(x => taskConfig.tasks[x] != null);
        if (!taskName) {
            console.log("Unknown task type for quest:", questName);
            return;
        }
        const taskData = taskConfig.tasks[taskName];
        const applicationId = quest.config.application?.id ?? taskData.applications?.[0]?.id;
        const secondsNeeded = taskData.target;
        let secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;

        if (!isApp && taskName !== "WATCH_VIDEO" && taskName !== "WATCH_VIDEO_ON_MOBILE") {
            console.log("This no longer works in browser for non-video quests (" + taskName + "). Use the discord desktop app to complete the", questName, "quest!");
            return;
        }

        completingQuest.set(quest.id, true);

        console.log(`Completing quest ${questName} (${quest.id}) - ${taskName} for ${secondsNeeded} seconds.`);

        const postWithRetry = async (url: string, body: any) => {
            let delay = 5;
            const maxDelay = 300;
            while (completingQuest.get(quest.id)) {
                try {
                    return await RestAPI.post({ url, body });
                } catch (err) {
                    console.warn(`Failed to POST to ${url} for quest ${questName}:`, err);
                    console.log("Retrying to POST for quest", questName, "in", delay, "seconds.");
                    await new Promise(resolve => setTimeout(resolve, delay * 1000));
                    if (delay < maxDelay) {
                        delay = Math.min(delay * 2, maxDelay);
                    } else {
                        delay = maxDelay;
                    }
                }
            }
        };

        switch (taskName) {
            case "WATCH_VIDEO":
            case "WATCH_VIDEO_ON_MOBILE":
                const enrolledAt = new Date(quest.userStatus.enrolledAt).getTime();
                const maxFuture = 10, speed = 7;
                let completed = false;
                const watchVideo = async () => {
                    while (true) {
                        if (!completingQuest.get(quest.id)) {
                            console.log("Stopping completing quest:", questName);
                            completingQuest.set(quest.id, false);
                            break;
                        }

                        const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + maxFuture;
                        const remaining = secondsDone + speed - maxAllowed;
                        const timestamp = secondsDone + speed;

                        await new Promise(resolve => setTimeout(resolve, Math.max(0, remaining) * 1000));
                        const res = await postWithRetry(`/quests/${quest.id}/video-progress`, { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) });
                        if (res) {
                            completed = res.body.completed_at != null;
                            secondsDone = Math.min(secondsNeeded, timestamp);
                        }

                        if (timestamp >= secondsNeeded) {
                            break;
                        }
                    }
                    if (!completed) {
                        await postWithRetry(`/quests/${quest.id}/video-progress`, { timestamp: secondsNeeded });
                    } else {
                        console.log(`Quest ${questName} completed!`);
                    }
                    completingQuest.set(quest.id, false);
                };
                watchVideo();
                console.log(`Spoofing video for ${questName}.`);
                break;

            case "PLAY_ON_DESKTOP":
                RestAPI.get({ url: `/applications/public?application_ids=${applicationId}` }).then(res => {
                    const appData = res.body[0];
                    const exeName = appData.executables?.find(x => x.os === "win32")?.name?.replace(">","") ?? appData.name.replace(/[\/\\:*?"<>|]/g, "");

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
                        if (event.questId !== quest.id) return;
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

                    console.log(`Spoofed your game to ${appData.name}. Wait for ${Math.ceil((secondsNeeded - secondsDone) / 60)} more minutes.`);
                });
                break;

            case "STREAM_ON_DESKTOP":
                const fakeApp = {
                    id: applicationId,
                    /*name: `FakeApp ${applicationId} (CompleteDiscordQuest)`,*/
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

                console.log(`Spoofed your stream to the target game. Stream any window in vc for ${Math.ceil((secondsNeeded - secondsDone) / 60)} more minutes.`);
                console.log("Remember that you need at least 1 other person to be in the vc!");
                break;

            case "PLAY_ACTIVITY":
                const channelId = ChannelStore.getSortedPrivateChannels()[0]?.id ?? Object.values(GuildChannelStore.getAllGuilds()).find(x => x != null && x.VOCAL.length > 0).VOCAL[0].channel.id;
                const streamKey = `call:${channelId}:1`;

                const playActivity = async () => {
                    console.log("Completing quest", questName, "-", quest.config.messages.questName);

                    while (true) {
                        const res = await postWithRetry(`/quests/${quest.id}/heartbeat`, { stream_key: streamKey, terminal: false });
                        if (!res) break;
                        const progress = res.body.progress.PLAY_ACTIVITY.value;
                        console.log(`Quest progress ${questName}: ${progress}/${secondsNeeded}`);

                        await new Promise(resolve => setTimeout(resolve, 20 * 1000));

                        if (!completingQuest.get(quest.id) || progress >= secondsNeeded) {
                            console.log("Stopping completing quest:", questName);

                            if (progress >= secondsNeeded) {
                                await postWithRetry(`/quests/${quest.id}/heartbeat`, { stream_key: streamKey, terminal: true });
                                console.log("Quest completed!");
                                completingQuest.set(quest.id, false);
                            }
                            break;
                        }
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
