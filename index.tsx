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
import { 
    getApplicationStreamingStore, 
    getChannelStore, 
    getGuildChannelStore, 
    getQuestsStore, 
    getRunningGameStore 
} from "./stores";

const QuestApplyAction = findByCodeLazy("type:\"QUESTS_ENROLL_BEGIN\"") as (questId: string, action: any) => Promise<any>;
const QuestLocationMap = findByPropsLazy("QUEST_HOME_DESKTOP", "11") as Record<string, any>;

let availableQuests: any[] = [];
let acceptableQuests: any[] = [];
let completableQuests: any[] = [];

const completingQuest = new Map<string, boolean>();
const fakeGames = new Map<string, any>();
const fakeApplications = new Map<string, any>();

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
        name: "tah.toh", 
        id: 756926734607056977n
    },{
        name: "nicola02nb", 
        id: 257900031351193600n
    }],
    settings,
    patches: [
        {
            find: ".PlatformTypes.WEB",
            replacement: {
                match: /(\((\i)\){)(let{leading)/,
                replace: "$1$2?.trailing?.props?.children?.unshift?.($self.renderQuestButtonTopBar());$3"
            }
        },
        {
            find: "accountContainerRef:",
            replacement: {
                match: /className:\i\.Uo,style:\i,children:\[/,
                replace: "$&$self.renderQuestButtonSettingsBar(),"
            }
        },
        {
            // Sidebar Navigation Item Patch ("Quests" link indicated in image)
            find: "connected-accounts",
            replacement: {
                match: /(children:\[.*?\(\d+,\i\.jsx\)\(\i,\{to:"\/nitro"\}[^\]]*?)(?=\]\})/,
                replace: "$1,$self.renderSidebarQuestsButton()"
            }
        },
        { // PTB / Badges Experimental
            find: "\"innerRef\",\"navigate\",\"onClick\"",
            replacement: {
                match: /(\i).createElement\("a",(\i)\)/,
                replace: "$1.createElement(\"a\",$self.renderQuestButtonBadges($2))"
            }
        }
    ],
    start: () => {
        if (!ensureHasAcceptedToUsePlugin()) {
            stopAllFarming();
            return;
        }

        const questsStore = getQuestsStore();
        if (questsStore && typeof questsStore.addChangeListener === "function") {
            try {
                questsStore.addChangeListener(updateQuests);
            } catch (err) {
                console.error("[CompleteDiscordQuest] Add listener error:", err);
            }
        }
        updateQuests();
    },
    stop: () => {
        const questsStore = getQuestsStore();
        if (questsStore && typeof questsStore.removeChangeListener === "function") {
            try {
                questsStore.removeChangeListener(updateQuests);
            } catch (err) {
                console.error("[CompleteDiscordQuest] Remove listener error:", err);
            }
        }
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

    renderSidebarQuestsButton() {
        return <QuestButton type="settings-bar" />;
    },

    renderQuestButtonBadges(questButton: any) {
        if (settings.store.showQuestsButtonBadges && typeof questButton === "string" && questButton === "quests") {
            return (<QuestsCount />);
        }
        if (settings.store.showQuestsButtonBadges && questButton?.href?.startsWith("/quest-home")
            && Array.isArray(questButton?.children) && questButton.children.findIndex((child: any) => child?.type === QuestsCount) === -1) {
            questButton.children.push(<QuestsCount />);
        }
        return questButton;
    },

    getRunningGames() {
        if (fakeGames.size > 0) {
            return Array.from(fakeGames.values());
        }
    },

    getGameForPID(pid: number) {
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

function isQuestEligibleForFarming(quest: any): boolean {
    const questConfig = quest?.config?.taskConfig || quest?.config?.taskConfigV2;
    if (!questConfig?.tasks) return false;

    const taskKeys = Object.keys(questConfig.tasks);
    return taskKeys.some(taskName => {
        return (taskName === "WATCH_VIDEO" && settings.store.farmVideos
            || taskName === "WATCH_VIDEO_ON_MOBILE" && settings.store.farmVideos
            || taskName === "PLAY_ON_DESKTOP" && settings.store.farmPlayOnDesktop
            || taskName === "STREAM_ON_DESKTOP" && settings.store.farmStreamOnDesktop
            || taskName === "PLAY_ACTIVITY" && settings.store.farmPlayActivity);
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

    const questsStore = getQuestsStore();
    if (!questsStore) return;

    let questMap: Map<string, any> | null = null;
    if (questsStore.quests instanceof Map) {
        questMap = questsStore.quests;
    } else if (typeof questsStore.getQuests === "function") {
        questMap = questsStore.getQuests();
    }

    if (!questMap || !(questMap instanceof Map)) return;

    try {
        availableQuests = [...questMap.values()];
        acceptableQuests = availableQuests.filter(x => x?.userStatus?.enrolledAt == null && new Date(x?.config?.expiresAt).getTime() > Date.now());
        completableQuests = availableQuests.filter(x => x?.userStatus?.enrolledAt && !x?.userStatus?.completedAt && new Date(x?.config?.expiresAt).getTime() > Date.now());

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
    } catch (err) {
        console.error("[CompleteDiscordQuest] Error updating quests:", err);
    }
}

function acceptQuest(quest: any) {
    console.log("[CompleteDiscordQuest] Enrolling quest:", quest.config?.messages?.questName);
    const action = {
        questContent: QuestLocationMap?.QUEST_HOME_DESKTOP ?? 1,
        questContentCTA: "ACCEPT_QUEST",
        sourceQuestContent: 0,
    };
    if (typeof QuestApplyAction === "function") {
        try {
            QuestApplyAction(quest.id, action).then(() => {
                console.log("[CompleteDiscordQuest] Accepted quest:", quest.config?.messages?.questName);
                updateQuests();
            }).catch(err => {
                console.error("[CompleteDiscordQuest] Failed to accept quest:", quest.config?.messages?.questName, err);
            });
        } catch (err) {
            console.error("[CompleteDiscordQuest] Exception during QuestApplyAction:", err);
        }
    }
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
        const runningGameStore = getRunningGameStore();
        const games = runningGameStore?.getRunningGames?.() ?? [];
        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: removedGames, added: games, games });
    }

    if (fakeApplications.size > 0) {
        fakeApplications.clear();
    }
}

function completeQuest(quest: any) {
    if (!settings.store.hasAcceptedToUsePlugin) {
        stopAllFarming();
        console.warn("Consent not accepted. Cannot complete quests.");
        return;
    }

    if (!quest) return;

    const pid = Math.floor(Math.random() * 30000) + 1000;
    const applicationId = quest.config?.application?.id;
    const applicationName = quest.config?.application?.name;
    const questName = quest.config?.messages?.questName ?? "Unknown Quest";
    const taskConfig = quest.config?.taskConfig ?? quest.config?.taskConfigV2;

    if (!taskConfig?.tasks) return;

    const taskName = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"].find(x => taskConfig.tasks[x] != null);
    if (!taskName) return;

    const secondsNeeded = taskConfig.tasks[taskName].target;
    let secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;

    completingQuest.set(quest.id, true);
    console.log(`[CompleteDiscordQuest] Completing ${questName} (${taskName}) - Target: ${secondsNeeded}s`);

    switch (taskName) {
        case "WATCH_VIDEO":
        case "WATCH_VIDEO_ON_MOBILE":
            const watchVideo = async () => {
                const stepSeconds = 7;
                let currentProgress = secondsDone;

                while (completingQuest.get(quest.id) && currentProgress < secondsNeeded) {
                    currentProgress = Math.min(secondsNeeded, currentProgress + stepSeconds);

                    try {
                        const res = await RestAPI.post({
                            url: `/quests/${quest.id}/video-progress`,
                            body: { 
                                timestamp: currentProgress,
                                current_progress_seconds: currentProgress
                            }
                        });

                        console.log(`[Video Quest] ${questName} progress: ${currentProgress}/${secondsNeeded}s`);

                        if (res.body?.completed_at != null || currentProgress >= secondsNeeded) {
                            console.log(`Quest completed!`);
                            completingQuest.set(quest.id, false);
                            break;
                        }
                    } catch (err) {
                        console.error(`[Video Quest] Failed progress report for ${questName}:`, err);
                        completingQuest.set(quest.id, false);
                        break;
                    }

                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            };

            watchVideo();
            break;

        case "PLAY_ON_DESKTOP":
        case "PLAY_ACTIVITY":
            const playDesktopQuest = async () => {
                const exeName = applicationName?.replace(/[\/\\:*?"<>|]/g, "") ?? "game";
                const fakeGame = {
                    cmdLine: `/usr/bin/${exeName}`,
                    exeName,
                    exePath: `/usr/bin/${exeName.toLowerCase()}`,
                    hidden: false,
                    isLauncher: false,
                    id: applicationId,
                    name: applicationName,
                    pid: pid,
                    pidPath: [pid],
                    processName: applicationName,
                    start: Date.now(),
                };

                fakeGames.set(quest.id, fakeGame);
                FluxDispatcher.dispatch({ 
                    type: "RUNNING_GAMES_CHANGE", 
                    removed: [], 
                    added: [fakeGame], 
                    games: Array.from(fakeGames.values()) 
                });

                while (completingQuest.get(quest.id)) {
                    try {
                        const res = await RestAPI.post({
                            url: `/quests/${quest.id}/heartbeat`,
                            body: { terminal: false }
                        });

                        const progress = res.body?.progress?.PLAY_ON_DESKTOP?.value 
                            ?? res.body?.progress?.PLAY_ACTIVITY?.value 
                            ?? 0;

                        console.log(`[Play Quest] ${questName} progress: ${progress}/${secondsNeeded}s`);

                        if (res.body?.completed_at != null || progress >= secondsNeeded) {
                            await RestAPI.post({
                                url: `/quests/${quest.id}/heartbeat`,
                                body: { terminal: true }
                            });
                            console.log(`[Play Quest] Quest completed: ${questName}`);
                            completingQuest.set(quest.id, false);
                            fakeGames.delete(quest.id);
                            FluxDispatcher.dispatch({ 
                                type: "RUNNING_GAMES_CHANGE", 
                                removed: [fakeGame], 
                                added: [], 
                                games: Array.from(fakeGames.values()) 
                            });
                            break;
                        }
                    } catch (err) {
                        console.error(`[Play Quest] Heartbeat failed for ${questName}:`, err);
                        completingQuest.set(quest.id, false);
                        break;
                    }

                    await new Promise(resolve => setTimeout(resolve, 20000));
                }
            };

            playDesktopQuest();
            break;

        default:
            completingQuest.set(quest.id, false);
            break;
    }
}
