/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { filters, find, waitFor } from "@webpack";

import * as t from "./types/stores";

function safeLazy<T extends object>(filter: (m: any) => boolean): T {
    let cached: any = null;
    waitFor(filter, (m: any) => {
        cached = m;
    });
    const resolve = () => cached ?? (cached = find(filter, { isIndirect: true }));
    return new Proxy({} as T, {
        get(_target, prop) {
            const mod = resolve();
            if (!mod) return undefined;
            const val = Reflect.get(mod, prop, mod);
            return typeof val === "function" ? val.bind(mod) : val;
        },
        set(_target, prop, value) {
            const mod = resolve();
            if (!mod) return true;
            return Reflect.set(mod, prop, value, mod);
        },
        has(_target, prop) {
            const mod = resolve();
            return mod ? Reflect.has(mod, prop) : false;
        }
    });
}

export const ApplicationStreamingStore: t.ApplicationStreamingStore = safeLazy(filters.byStoreName("ApplicationStreamingStore"));
export const RunningGameStore: t.RunningGameStore = safeLazy(filters.byStoreName("RunningGameStore"));
export const QuestsStore: t.QuestsStore = safeLazy(filters.byProps("getQuest"));
export const AdDeliveryStore: any = safeLazy(filters.byStoreName("AdDeliveryStore"));
export const ChannelStore: t.ChannelStore = safeLazy(filters.byStoreName("ChannelStore"));
export const GuildChannelStore: t.GuildChannelStore = safeLazy(filters.byStoreName("GuildChannelStore"));
export const UserStore: any = safeLazy(filters.byStoreName("UserStore"));
export const SuperPropertiesStore: any = safeLazy(filters.byProps("getSuperProperties", "encodeProperties"));
