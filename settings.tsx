/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import { Forms } from "@webpack/common";

function AchievementCaution() {
    return (
        <div style={{
            background: "var(--background-modifier-accent)",
            border: "1px solid var(--status-danger, #f23f42)",
            borderLeft: "4px solid var(--status-danger, #f23f42)",
            borderRadius: 4,
            padding: "10px 14px",
            marginTop: 8,
            marginBottom: 4,
        }}>
            <Forms.FormText style={{ color: "var(--status-danger, #f23f42)", fontWeight: "bold", marginBottom: 6 }}>
                ⚠️ CAUTION:
            </Forms.FormText>
            <Forms.FormText style={{ color: "var(--text-normal)" }}>
                This works by OAuth-authorizing the quest's app on your account, reporting progress
                to the activity backend, then revoking the grant afterward.
                This automates actions on your logged-in account and may put your account at risk
                under{" "}
                <a
                    href="https://discord.com/terms"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--text-link)" }}
                >
                    Discord's Terms of Service
                </a>
                . Off by default — enabling it is your explicit consent.
            </Forms.FormText>
        </div>
    );
}

export default definePluginSettings({
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
    farmAchievement: {
        type: OptionType.BOOLEAN,
        description: "Farm ACHIEVEMENT_IN_ACTIVITY quests automatically (see caution below).",
        default: false
    },
    farmAchievementCaution: {
        type: OptionType.COMPONENT,
        description: "",
        component: AchievementCaution,
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
