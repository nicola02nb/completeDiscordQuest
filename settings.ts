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
