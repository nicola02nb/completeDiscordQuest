/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export default definePluginSettings({
    hasAcceptedToUsePlugin: {
        type: OptionType.BOOLEAN,
        description: "Required consent for running quest automation. Disable to force-stop quest farming.",
        default: false
    },
    acceptQuestsAutomatically: {
        type: OptionType.BOOLEAN,
        description: "Whether to accept available quests automatically.",
        default: true
    },
    claimRewardsAutomatically: {
        type: OptionType.BOOLEAN,
        description: "Whether to automatically claim completed quest rewards (Orbs, Decorations, Nitro, and single/multi-platform reward codes using the configured platform priority).",
        default: true
    },
    rewardPlatformPriority: {
        type: OptionType.SELECT,
        description: "Preferred platform priority when automatically claiming multi-platform reward codes (e.g. PC vs PS5 vs Xbox vs Switch).",
        options: [
            { label: "PC -> PlayStation (PS5) -> Xbox -> Switch (Default)", value: "4,2,1,3,0", default: true },
            { label: "PC -> Xbox -> PlayStation (PS5) -> Switch", value: "4,1,2,3,0" },
            { label: "PlayStation (PS5) -> PC -> Xbox -> Switch", value: "2,4,1,3,0" },
            { label: "Xbox -> PC -> PlayStation (PS5) -> Switch", value: "1,4,2,3,0" },
            { label: "Switch -> PC -> PlayStation (PS5) -> Xbox", value: "3,4,2,1,0" },
            { label: "Skip multi-platform rewards (choose manually)", value: "manual" }
        ]
    },
    showQuestsButtonTopBar: {
        type: OptionType.BOOLEAN,
        description: "Whether to show the quests button in the top bar.",
        default: true,
        restartNeeded: true
    },
    showQuestsButtonSettingsBar: {
        type: OptionType.BOOLEAN,
        description: "Whether to show the quests button in the settings bar.",
        default: false,
        restartNeeded: true
    },
    showQuestsButtonBadges: {
        type: OptionType.BOOLEAN,
        description: "Whether to show badges on the quests button.",
        default: true
    },
    farmVideos: {
        type: OptionType.BOOLEAN,
        description: "Whether to farm video quests automatically.",
        default: true
    },
    farmPlayOnDesktop: {
        type: OptionType.BOOLEAN,
        description: "Whether to farm play on desktop quests automatically.",
        default: true
    },
    farmStreamOnDesktop: {
        type: OptionType.BOOLEAN,
        description: "Whether to farm stream on desktop quests automatically.",
        default: true
    },
    farmPlayActivity: {
        type: OptionType.BOOLEAN,
        description: "Whether to farm play activity quests automatically.",
        default: true
    },
    farmAchievementInActivity: {
        type: OptionType.BOOLEAN,
        description: "Whether to farm interactive activity / achievement quests automatically.",
        default: true
    },
    farmRewardCodes: {
        type: OptionType.BOOLEAN,
        description: "Whether to farm reward code quests automatically.",
        default: true
    },
    farmInGame: {
        type: OptionType.BOOLEAN,
        description: "Whether to farm in-game quests automatically.",
        default: true
    },
    farmCollectibles: {
        type: OptionType.BOOLEAN,
        description: "Whether to farm collectible quests automatically.",
        default: true
    },
    farmVirtualCurrency: {
        type: OptionType.BOOLEAN,
        description: "Whether to farm virtual currency quests automatically.",
        default: true
    },
    farmFractionalPremium: {
        type: OptionType.BOOLEAN,
        description: "Whether to farm fractional premium quests automatically.",
        default: true
    },
});
