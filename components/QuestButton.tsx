/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./QuestButton.css";

import { Flex } from "@components/Flex";
import { findByCodeLazy, findByPropsLazy, findComponentByCodeLazy } from "@webpack";
import { Tooltip, useEffect, useState } from "@webpack/common";

import { getQuestsStore } from "../stores";

const QuestIcon = findByCodeLazy("\"M7.5 21.7a8.95");
const { navigateToQuestHome } = findByPropsLazy("navigateToQuestHome") ?? {};
const TopBarButton = findComponentByCodeLazy("badgePosition", "icon");
const SettingsBarButton = findComponentByCodeLazy("keyboardShortcut", "positionKey");
const CountBadge = findComponentByCodeLazy("renderBadgeCount", "disableColor");

function questsStatus() {
    const store = getQuestsStore();
    const questsMap = store?.quests ?? (typeof store?.getQuests === "function" ? store.getQuests() : null);
    if (!questsMap || !(questsMap instanceof Map)) {
        return { enrollable: 0, enrolled: 0, claimable: 0, claimed: 0, expired: 0 };
    }

    const availableQuests = [...questsMap.values()];
    return availableQuests.reduce((acc, x) => {
        if (new Date(x.config?.expiresAt).getTime() < Date.now()) {
            acc.expired++;
        } else if (x.userStatus?.claimedAt) {
            acc.claimed++;
        } else if (x.userStatus?.completedAt) {
            acc.claimable++;
        } else if (x.userStatus?.enrolledAt) {
            acc.enrolled++;
        } else {
            acc.enrollable++;
        }
        return acc;
    }, { enrollable: 0, enrolled: 0, claimable: 0, claimed: 0, expired: 0 });
}

export function QuestsCount() {
    const [status, setStatus] = useState(questsStatus());

    const checkForNewQuests = () => {
        setStatus(questsStatus());
    };

    useEffect(() => {
        const store = getQuestsStore();
        if (store?.addChangeListener) {
            try { store.addChangeListener(checkForNewQuests); } catch {}
            return () => {
                try { store.removeChangeListener(checkForNewQuests); } catch {}
            };
        }
    }, []);

    return (
        <Flex flexDirection={"row"} justifyContent={"flex-end"} className={"quest-button-badges"} gap={"5px"}>
            {status.enrollable > 0 && (
                <Tooltip text={"Enrollable"}>
                    {({ onMouseEnter, onMouseLeave }) => (
                        <CountBadge
                            onMouseEnter={onMouseEnter}
                            onMouseLeave={onMouseLeave}
                            count={status.enrollable}
                            color={"var(--status-danger)"}
                            style={{ color: "var(--background-base-lowest)" }}
                        />
                    )}
                </Tooltip>
            )}
            {status.enrolled > 0 && (
                <Tooltip text={"Enrolled"}>
                    {({ onMouseEnter, onMouseLeave }) => (
                        <CountBadge
                            onMouseEnter={onMouseEnter}
                            onMouseLeave={onMouseLeave}
                            count={status.enrolled}
                            color={"var(--status-warning)"}
                            style={{ color: "var(--background-base-lowest)" }}
                        />
                    )}
                </Tooltip>
            )}
            {status.claimable > 0 && (
                <Tooltip text={"Claimable"}>
                    {({ onMouseEnter, onMouseLeave }) => (
                        <CountBadge
                            onMouseEnter={onMouseEnter}
                            onMouseLeave={onMouseLeave}
                            count={status.claimable}
                            color={"var(--status-positive)"}
                            style={{ color: "var(--background-base-lowest)" }}
                        />
                    )}
                </Tooltip>
            )}
            {status.claimed > 0 && (
                <Tooltip text={"Claimed"}>
                    {({ onMouseEnter, onMouseLeave }) => (
                        <CountBadge
                            onMouseEnter={onMouseEnter}
                            onMouseLeave={onMouseLeave}
                            count={status.claimed}
                            color={"var(--blurple-50)"}
                            style={{ color: "var(--background-base-lowest)" }}
                        />
                    )}
                </Tooltip>
            )}
        </Flex>
    );
}

export function QuestButton({ type }: { type: "top-bar" | "settings-bar"; }) {
    const [state, setState] = useState(questsStatus());

    const checkForNewQuests = () => {
        setState(questsStatus());
    };

    useEffect(() => {
        const store = getQuestsStore();
        if (store?.addChangeListener) {
            try { store.addChangeListener(checkForNewQuests); } catch {}
            return () => {
                try { store.removeChangeListener(checkForNewQuests); } catch {}
            };
        }
    }, []);

    const className = state.enrollable ? "quest-button-enrollable" : state.enrolled ? "quest-button-enrolled" : state.claimable ? "quest-button-claimable" : "";
    const tooltip = state.enrollable ? `${state.enrollable} Enrollable Quests` : state.enrolled ? `${state.enrolled} Enrolled Quests` : state.claimable ? `${state.claimable} Claimable Quests` : "Quests";

    if (type === "top-bar" && TopBarButton) {
        return (
            <TopBarButton
                className={className}
                iconClassName={undefined}
                disabled={navigateToQuestHome === undefined}
                showBadge={state.enrollable > 0 || state.enrolled > 0 || state.claimable > 0}
                badgePosition={"bottom"}
                icon={QuestIcon}
                iconSize={20}
                onClick={navigateToQuestHome}
                onContextMenu={undefined}
                tooltip={tooltip}
                tooltipPosition={"bottom"}
                hideOnClick={false}
            />
        );
    } else if (type === "settings-bar" && SettingsBarButton) {
        return (
            <SettingsBarButton
                tooltipText={tooltip}
                onContextMenu={undefined}
                onClick={navigateToQuestHome}
                disabled={navigateToQuestHome === undefined}
                icon={undefined}
                className={"quest-button"}
            >
                {TopBarButton && (
                    <TopBarButton
                        className={className}
                        iconClassName={undefined}
                        disabled={navigateToQuestHome === undefined}
                        showBadge={state.enrollable > 0 || state.enrolled > 0 || state.claimable > 0}
                        badgePosition={"bottom"}
                        icon={QuestIcon}
                        iconSize={20}
                        onClick={navigateToQuestHome}
                        onContextMenu={undefined}
                        hideOnClick={false}
                    />
                )}
            </SettingsBarButton>
        );
    }

    return null;
}
