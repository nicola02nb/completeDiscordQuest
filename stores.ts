/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByProps, findByPropsLazy, findStore, findStoreLazy } from "@webpack";

// Export lazy proxies for JSX component imports (QuestButton.tsx)
export const QuestsStore: any = findStoreLazy("QuestsStore");
export const RunningGameStore: any = findStoreLazy("RunningGameStore");
export const ApplicationStreamingStore: any = findStoreLazy("ApplicationStreamingStore");
export const ChannelStore: any = findStoreLazy("ChannelStore");
export const GuildChannelStore: any = findStoreLazy("GuildChannelStore");

// Safe runtime getter functions for background execution
export function getQuestsStore(): any {
    try {
        const store = findStore("QuestsStore");
        if (store) return store;
    } catch {}

    try {
        const propsStore = findByProps("getQuest", "quests") ?? findByProps("getQuest") ?? findByProps("quests");
        if (propsStore) return propsStore;
    } catch {}

    return null;
}

export function getRunningGameStore(): any {
    try {
        const store = findStore("RunningGameStore");
        if (store) return store;
    } catch {}

    try {
        const propsStore = findByProps("getRunningGames") ?? findByProps("getRunningGame");
        if (propsStore) return propsStore;
    } catch {}

    return null;
}

export function getApplicationStreamingStore(): any {
    try {
        const store = findStore("ApplicationStreamingStore");
        if (store) return store;
    } catch {}

    try {
        const propsStore = findByProps("getStreamerActiveStreamMetadata");
        if (propsStore) return propsStore;
    } catch {}

    return null;
}

export function getChannelStore(): any {
    try {
        const store = findStore("ChannelStore");
        if (store) return store;
    } catch {}

    try {
        const propsStore = findByProps("getSortedPrivateChannels");
        if (propsStore) return propsStore;
    } catch {}

    return null;
}

export function getGuildChannelStore(): any {
    try {
        const store = findStore("GuildChannelStore");
        if (store) return store;
    } catch {}

    try {
        const propsStore = findByProps("getAllGuilds");
        if (propsStore) return propsStore;
    } catch {}

    return null;
}
